import { createTenantSender, type Fetch, type FetchInit } from '@dr/shared/ses'
import { describe, expect, it, vi } from 'vitest'
import { createPacer } from './pacing'
import { createSender, HEARTBEAT_NAME, type SenderOptions, THROTTLE_RETRY_SECONDS } from './sender'
import type {
  ClaimedEmail,
  HeartbeatDetail,
  MailStore,
  SendOutcome,
  UnreadableClaim,
} from './store'

/**
 * The send loop against a mock SES at the network boundary (no test ever
 * reaches AWS — N12, for email) and a fake store standing in for the SQL
 * functions, which supabase/tests/mail_sending.sql proves.
 */

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

const email = (over: Partial<ClaimedEmail> = {}): ClaimedEmail => ({
  id: 41,
  publicId: '6f1d3a52-2a0e-4f0b-9d55-0c1f2a3b4c5d',
  accountShortId: '0a1b2c3d4e',
  tenant: 'mdm-0a1b2c3d4e',
  configurationSet: 'mdm-0a1b2c3d4e',
  from: 'Acme <receipts@acme.example>',
  to: ['ada@example.com'],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: 'Your receipt',
  tags: [{ name: 'kind', value: 'receipt' }],
  recipientCount: 1,
  attempt: 1,
  html: '<p>Thanks!</p>',
  text: null,
  headers: {},
  attachments: [],
  ...over,
})

type Answer = { status: number; body?: unknown; errorType?: string } | Error

/** SES as it answers on the wire: each send takes the next scripted answer. */
function mockSes(...answers: Answer[]) {
  const calls: { url: string; init: FetchInit }[] = []
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init })
    const answer = answers.length > 1 ? answers.shift() : answers[0]
    if (!answer) throw new Error('no answer scripted')
    if (answer instanceof Error) throw answer
    return {
      status: answer.status,
      headers: {
        get: (name: string) => (name === 'x-amzn-errortype' ? (answer.errorType ?? null) : null),
      },
      text: async () => JSON.stringify(answer.body ?? {}),
    }
  }
  const ses = createTenantSender({
    region: 'eu-west-2',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'test secret, not a real key',
    fetch,
    now: () => new Date('2026-10-06T09:30:00Z'),
  })
  return { ses, calls }
}

function fakeStore(claims: (ClaimedEmail | UnreadableClaim)[][] = [], recordAnswer = true) {
  const queue = [...claims]
  const recorded: { id: number; worker: string; result: SendOutcome }[] = []
  const beats: { name: string; detail: HeartbeatDetail }[] = []
  const store = {
    claim: vi.fn(
      async (_worker: string, _limit: number, _paidOnly: boolean) => queue.shift() ?? [],
    ),
    record: vi.fn(async (id: number, worker: string, result: SendOutcome) => {
      recorded.push({ id, worker, result })
      return recordAnswer
    }),
    heartbeat: vi.fn(async (name: string, detail: HeartbeatDetail) => {
      beats.push({ name, detail })
    }),
  } satisfies MailStore
  return { store, recorded, beats }
}

function sender(
  store: MailStore,
  ses: ReturnType<typeof mockSes>['ses'],
  over: Partial<SenderOptions> = {},
) {
  return createSender({
    store,
    ses,
    pacer: createPacer(1000, { now: () => 0, sleep: async () => {} }),
    workerId: 'mail-worker:test',
    batchSize: 10,
    pollMs: 1000,
    log,
    ...over,
  })
}

describe('a run of the send loop', () => {
  it('sends each claimed email through its tenant and configuration set, and records SES’s id', async () => {
    const { store, recorded, beats } = fakeStore([[email()]])
    const { ses, calls } = mockSes({ status: 200, body: { MessageId: '0102-m1' } })
    const run = await sender(store, ses).runOnce()

    expect(run).toEqual({ claimed: 1, sent: 1, failed: 0, retried: 0, throttled: 0 })
    expect(store.claim).toHaveBeenCalledWith('mail-worker:test', 10, false)
    const body = JSON.parse(calls[0]?.init.body ?? '{}')
    expect(body).toMatchObject({
      TenantName: 'mdm-0a1b2c3d4e',
      ConfigurationSetName: 'mdm-0a1b2c3d4e',
      FromEmailAddress: 'Acme <receipts@acme.example>',
      Destination: { ToAddresses: ['ada@example.com'] },
    })
    expect(body.EmailTags).toContainEqual({ Name: 'mdm_email', Value: email().publicId })
    expect(recorded).toEqual([
      { id: 41, worker: 'mail-worker:test', result: { outcome: 'sent', messageId: '0102-m1' } },
    ])
    expect(beats).toEqual([{ name: HEARTBEAT_NAME, detail: { ...run, paidOnly: false } }])
  })

  it('sends attachments as raw MIME', async () => {
    const { store } = fakeStore([
      [
        email({
          attachments: [
            { filename: 'r.pdf', content: 'JVBERi0x', content_type: 'application/pdf' },
          ],
        }),
      ],
    ])
    const { ses, calls } = mockSes({ status: 200, body: { MessageId: 'm' } })
    await sender(store, ses).runOnce()
    expect(JSON.parse(calls[0]?.init.body ?? '{}').Content).toHaveProperty('Raw.Data')
  })

  it('treats a throttle as "again shortly": queued with a wait, the bucket paused, never failed', async () => {
    const { store, recorded } = fakeStore([[email()]])
    const { ses } = mockSes({ status: 429, errorType: 'TooManyRequestsException' })
    const pause = vi.fn()
    const pacer = { take: vi.fn(async () => {}), pause, tokens: () => 1 }
    const run = await sender(store, ses, { pacer }).runOnce()
    expect(run.throttled).toBe(1)
    expect(pause).toHaveBeenCalledWith(1000)
    expect(recorded[0]?.result).toEqual({
      outcome: 'throttled',
      code: 'TooManyRequestsException',
      retryAfterSeconds: THROTTLE_RETRY_SECONDS,
    })
  })

  it('tries again after no answer, and fails what SES refused for good', async () => {
    const timeout = new Error('timed out')
    timeout.name = 'TimeoutError'
    const { store, recorded } = fakeStore([[email({ id: 1 }), email({ id: 2 }), email({ id: 3 })]])
    const { ses } = mockSes(
      timeout,
      { status: 400, errorType: 'MessageRejected', body: { message: 'ada@example.com' } },
      { status: 503 },
    )
    const run = await sender(store, ses).runOnce()
    expect(run).toMatchObject({ claimed: 3, retried: 2, failed: 1 })
    expect(recorded.map((r) => r.result)).toEqual([
      { outcome: 'retry', code: 'no_answer' },
      { outcome: 'failed', code: 'MessageRejected' },
      { outcome: 'retry', code: null },
    ])
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('ada@example.com')
  })

  it('never sends without a tenant (MR1): the email fails and SES is never called', async () => {
    const { store, recorded } = fakeStore([[email({ tenant: '' })]])
    const { ses, calls } = mockSes({ status: 200, body: { MessageId: 'm' } })
    await sender(store, ses).runOnce()
    expect(calls).toHaveLength(0)
    expect(recorded[0]?.result).toEqual({ outcome: 'failed', code: 'MissingTenant' })
  })

  it('fails a claimed row it cannot read, rather than leave it hanging', async () => {
    const { store, recorded } = fakeStore([[{ id: 7, unreadable: true }]])
    const { ses, calls } = mockSes({ status: 200 })
    expect((await sender(store, ses).runOnce()).failed).toBe(1)
    expect(calls).toHaveLength(0)
    expect(recorded[0]).toEqual({
      id: 7,
      worker: 'mail-worker:test',
      result: { outcome: 'failed', code: 'unreadable_claim' },
    })
  })

  it('carries on past a result it could not record, and says when the claim had moved on', async () => {
    const { store } = fakeStore([[email({ id: 1 }), email({ id: 2 })]], false)
    store.record.mockRejectedValueOnce(new Error('connection reset'))
    const { ses, calls } = mockSes({ status: 200, body: { MessageId: 'm' } })
    log.error.mockClear()
    await sender(store, ses).runOnce()
    expect(calls).toHaveLength(2)
    expect(log.error.mock.calls.map((call) => call[1])).toEqual([
      'a send could not be recorded',
      'the claim had passed to another worker; result not recorded',
    ])
  })

  it('paces by recipients: an email to three takes three', async () => {
    const { store } = fakeStore([
      [email({ recipientCount: 3, to: ['a@x.example', 'b@x.example', 'c@x.example'] })],
    ])
    const { ses } = mockSes({ status: 200, body: { MessageId: 'm' } })
    const pacer = { take: vi.fn(async () => {}), pause: vi.fn(), tokens: () => 1 }
    await sender(store, ses, { pacer }).runOnce()
    expect(pacer.take).toHaveBeenCalledWith(3)
  })

  it('asks for paid accounts only when the SES day is nearly spent', async () => {
    const { store } = fakeStore()
    const { ses } = mockSes({ status: 200 })
    await sender(store, ses, { paidOnly: () => true }).runOnce()
    expect(store.claim).toHaveBeenCalledWith('mail-worker:test', 10, true)
  })

  it('beats at most every 30 seconds while idle', async () => {
    const { store, beats } = fakeStore()
    const { ses } = mockSes({ status: 200 })
    let now = 0
    const loop = sender(store, ses, { clock: () => now })
    await loop.runOnce()
    now = 10_000
    await loop.runOnce()
    now = 31_000
    await loop.runOnce()
    expect(beats).toHaveLength(2)
    expect(loop.lastRunAt()).toBe(31_000)
  })
})

describe('the loop', () => {
  it('goes again at once after a full batch, rests after a short one, and stops cleanly', async () => {
    const { store } = fakeStore([[email({ id: 1 }), email({ id: 2 })], [email({ id: 3 })]])
    const { ses } = mockSes({ status: 200, body: { MessageId: 'm' } })
    const sleeps: number[] = []
    let loop: ReturnType<typeof sender> | null = null
    loop = sender(store, ses, {
      batchSize: 2,
      sleep: async (ms) => {
        sleeps.push(ms)
        await loop?.stop()
      },
    })
    loop.start()
    loop.start()
    await vi.waitFor(() => expect(sleeps).toEqual([1000]))
    expect(store.claim).toHaveBeenCalledTimes(2)
  })

  it('survives a run that fails, and tries again after resting', async () => {
    const { store } = fakeStore()
    store.claim.mockRejectedValueOnce(new Error('database unreachable'))
    const { ses } = mockSes({ status: 200 })
    let calls = 0
    let loop: ReturnType<typeof sender> | null = null
    loop = sender(store, ses, {
      sleep: async () => {
        calls += 1
        if (calls === 2) await loop?.stop()
      },
    })
    log.error.mockClear()
    loop.start()
    await vi.waitFor(() => expect(calls).toBe(2))
    expect(log.error).toHaveBeenCalledWith({ err: 'database unreachable' }, 'mail send run failed')
  })
})
