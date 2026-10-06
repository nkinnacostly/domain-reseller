import { newWebhookSecret, sealWebhookSecret, verifyWebhook } from '@dr/shared/webhooks'
import { describe, expect, it, vi } from 'vitest'
import { createWebhookDeliverer, USER_AGENT, WEBHOOK_HEARTBEAT } from './deliverer'
import type { Attempt, ClaimedDelivery, UnreadableDelivery, WebhookStore } from './store'
import type { Delivery, Transport, TransportResult } from './transport'

/**
 * The webhook loop (MAIL-SPEC §6, MR6): each claimed delivery signed with its
 * endpoint's own secret — verifiable by the receiver with the Standard
 * Webhooks check — posted, and its answer recorded for SQL to judge; a
 * secret that will not open fails that delivery alone.
 */

const KEY = new Uint8Array(32).map((_, i) => i * 7)
const ACCOUNT = '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e'
const NOW = new Date('2026-10-06T08:00:00Z')

async function claimed(over: Partial<ClaimedDelivery> = {}, secret = newWebhookSecret()) {
  return {
    secret,
    delivery: {
      id: 7,
      webhookId: '2c9e7f10-3b2a-4c4d-8e5f-6a7b8c9d0e1f',
      accountId: ACCOUNT,
      url: 'https://hooks.acme.example/mdh',
      secretSealed: await sealWebhookSecret(KEY, secret, ACCOUNT),
      messageId: `msg_${'a'.repeat(32)}`,
      eventType: 'email.delivered',
      payload: {
        type: 'email.delivered',
        created_at: '2026-10-06T07:59:59.000Z',
        data: { email_id: '7d2f0c1e-4a5b-4c6d-8e9f-0a1b2c3d4e5f' },
      },
      attempt: 1,
      ...over,
    } satisfies ClaimedDelivery,
  }
}

function fakeStore(claims: (ClaimedDelivery | UnreadableDelivery)[][]) {
  const recorded: { id: number; worker: string; attempt: Attempt }[] = []
  const claimedWith: unknown[][] = []
  const store: WebhookStore = {
    claim: vi.fn(async (...args: unknown[]) => {
      claimedWith.push(args)
      return claims.shift() ?? []
    }),
    record: vi.fn(async (id: number, worker: string, attempt: Attempt) => {
      recorded.push({ id, worker, attempt })
      return true
    }),
  }
  return { store, recorded, claimedWith }
}

const answer = (over: Partial<TransportResult> = {}): TransportResult => ({
  status: 200,
  error: null,
  response: 'ok',
  durationMs: 12,
  ...over,
})

function deliverer(
  store: WebhookStore,
  transport: Transport,
  extra: Partial<Parameters<typeof createWebhookDeliverer>[0]> = {},
) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const heartbeat = vi.fn(async () => undefined)
  return {
    log,
    heartbeat,
    loop: createWebhookDeliverer({
      store,
      transport,
      key: KEY,
      workerId: 'mail-worker:test',
      batchSize: 10,
      concurrency: 3,
      pollMs: 5,
      log,
      heartbeat,
      now: () => NOW,
      ...extra,
    }),
  }
}

describe('delivering a webhook', () => {
  it('signs with the endpoint’s secret so the receiver can verify it, and records the answer', async () => {
    const { delivery, secret } = await claimed()
    const { store, recorded } = fakeStore([[delivery]])
    const sent: Delivery[] = []
    const { loop, heartbeat } = deliverer(store, async (request) => {
      sent.push(request)
      return answer({ status: 204, response: null })
    })
    expect(await loop.runOnce()).toEqual({ claimed: 1, delivered: 1, failed: 0, unreadable: 0 })

    const request = sent[0] as Delivery
    expect(request.url).toBe(delivery.url)
    expect(JSON.parse(request.body)).toEqual(delivery.payload)
    expect(request.headers).toMatchObject({
      'webhook-id': delivery.messageId,
      'webhook-timestamp': String(NOW.getTime() / 1000),
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
    })
    const headers = {
      id: request.headers['webhook-id'] ?? null,
      timestamp: request.headers['webhook-timestamp'] ?? null,
      signature: request.headers['webhook-signature'] ?? null,
    }
    expect(await verifyWebhook(secret, headers, request.body, NOW)).toBe(true)
    expect(await verifyWebhook(newWebhookSecret(), headers, request.body, NOW)).toBe(false)
    expect(recorded).toEqual([
      {
        id: 7,
        worker: 'mail-worker:test',
        attempt: { status: 204, error: null, response: null, durationMs: 12 },
      },
    ])
    expect(heartbeat).toHaveBeenCalledWith({ claimed: 1, delivered: 1, failed: 0, unreadable: 0 })
  })

  it('records a refusal or no answer for SQL to retry, and logs no URL path or payload', async () => {
    const first = await claimed()
    const second = await claimed({ id: 8 })
    const { store, recorded } = fakeStore([[first.delivery, second.delivery]])
    const answers = [
      answer({ status: 500, response: 'boom' }),
      answer({ status: null, error: 'timeout' }),
    ]
    const { loop, log } = deliverer(store, async () => answers.shift() ?? answer())
    expect(await loop.runOnce()).toMatchObject({ claimed: 2, delivered: 0, failed: 2 })
    expect(recorded.map((r) => r.attempt.status ?? r.attempt.error).sort()).toEqual(
      [500, 'timeout'].sort(),
    )
    expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/mdh|email_id|whsec/)
  })

  it('fails a delivery whose secret will not open — another key, another account — without posting it', async () => {
    const { delivery } = await claimed()
    const moved = { ...delivery, id: 9, accountId: '6f1d3a52-2a0e-4f0b-9d55-0c1f2a3b4c5d' }
    const { store, recorded } = fakeStore([[moved]])
    const transport = vi.fn(async () => answer())
    const { loop, log } = deliverer(store, transport)
    expect(await loop.runOnce()).toMatchObject({ unreadable: 1, delivered: 0 })
    expect(transport).not.toHaveBeenCalled()
    expect(recorded[0]?.attempt).toEqual({
      status: null,
      error: 'secret_unreadable',
      response: null,
      durationMs: null,
    })
    expect(log.error).toHaveBeenCalled()
  })

  it('fails a row it could not read, and carries on when one answer cannot be recorded', async () => {
    const { delivery } = await claimed()
    const { store, recorded } = fakeStore([[{ id: 3, unreadable: true }, delivery]])
    vi.mocked(store.record).mockImplementation(async (id, worker, attempt) => {
      recorded.push({ id, worker, attempt })
      if (id === 7) throw new Error('database away')
      return id !== 3
    })
    const { loop, log } = deliverer(store, async () => answer(), { concurrency: 1 })
    expect(await loop.runOnce()).toMatchObject({ claimed: 2, unreadable: 1, delivered: 1 })
    expect(recorded.map((r) => r.id)).toEqual([3, 7])
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: 7 }),
      'a webhook attempt could not be recorded',
    )
  })

  it('says when the claim had passed to another worker', async () => {
    const { delivery } = await claimed()
    const { store } = fakeStore([[delivery]])
    vi.mocked(store.record).mockResolvedValue(false)
    const { loop, log } = deliverer(store, async () => answer())
    await loop.runOnce()
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: 7 }),
      expect.stringContaining('another worker'),
    )
  })

  it('claims a test account’s deliveries only when it is named', async () => {
    const { store, claimedWith } = fakeStore([[]])
    const { loop } = deliverer(store, async () => answer(), { accountId: ACCOUNT })
    await loop.runOnce()
    expect(claimedWith[0]).toEqual(['mail-worker:test', 10, ACCOUNT])
  })
})

describe('the loop', () => {
  it('beats when idle no more than its interval, and after every run that did something', async () => {
    let at = 0
    const { store } = fakeStore([[], [], []])
    const { loop, heartbeat } = deliverer(store, async () => answer(), {
      clock: () => at,
      heartbeatEveryMs: 1000,
    })
    await loop.runOnce()
    at = 500
    await loop.runOnce()
    at = 1500
    await loop.runOnce()
    expect(heartbeat).toHaveBeenCalledTimes(2)
    expect(loop.lastRunAt()).toBe(1500)
  })

  it('runs until stopped, survives a failed run, and goes again at once after a full batch', async () => {
    const { delivery } = await claimed()
    const { store } = fakeStore([[delivery]])
    vi.mocked(store.claim)
      .mockRejectedValueOnce(new Error('claim failed'))
      .mockResolvedValueOnce([delivery])
      .mockResolvedValue([])
    const slept: number[] = []
    const { loop, log } = deliverer(store, async () => answer(), {
      batchSize: 1,
      sleep: async (ms) => {
        slept.push(ms)
        if (slept.length >= 2) void loop.stop()
      },
    })
    loop.start()
    loop.start()
    await vi.waitFor(() => expect(slept.length).toBeGreaterThanOrEqual(2))
    await loop.stop()
    expect(log.error).toHaveBeenCalledWith({ err: 'claim failed' }, 'webhook run failed')
    expect(vi.mocked(store.claim).mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(WEBHOOK_HEARTBEAT).toBe('mail-worker:webhooks')
  })
})
