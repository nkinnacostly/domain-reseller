import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mailer } from './brevo'
import { createEmailSender } from './sender'
import type { EmailStore, QueuedEmail } from './store'

const NOW = new Date('2026-09-24T12:00:00Z')
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

const email = (over: Partial<QueuedEmail> = {}): QueuedEmail => ({
  id: 'e1',
  kind: 'password_changed',
  toEmail: 'ada@gmail.com',
  data: { at: '2026-09-24T11:00:00Z', name: 'Ada' },
  attempts: 1,
  testMode: false,
  ...over,
})

function fakeStore(
  due: QueuedEmail[] = [],
  deliveryDue: Awaited<ReturnType<EmailStore['deliveryDue']>> = [],
) {
  return {
    claim: vi.fn(async () => due),
    sent: vi.fn(async () => true),
    failed: vi.fn(async () => true),
    skipped: vi.fn(async () => true),
    deliveryDue: vi.fn(async () => deliveryDue),
    recordDelivery: vi.fn(async () => {}),
  } satisfies EmailStore
}

function fakeMailer(over: Partial<Mailer> = {}): Mailer & { send: ReturnType<typeof vi.fn> } {
  return {
    send: vi.fn(async () => ({ ok: true as const, messageId: '<m1>' })),
    delivery: vi.fn(async () => 'delivered' as const),
    ...over,
  } as Mailer & { send: ReturnType<typeof vi.fn> }
}

const sender = (store: EmailStore, mailer: Mailer, testMode = false) =>
  createEmailSender({
    store,
    mailer,
    testMode,
    workerId: 'gw-1',
    siteUrl: 'https://www.mydomainshub.com',
    pollMs: 60_000,
    deliveryEveryMs: 60_000,
    log,
    now: () => NOW,
  })

beforeEach(() => vi.clearAllMocks())

describe('sending', () => {
  it('claims this side, renders from the template, sends and records the version', async () => {
    const store = fakeStore([email()])
    const mailer = fakeMailer()
    expect(await sender(store, mailer, true).sendDue()).toEqual({ sent: 1, failed: 0, skipped: 0 })

    expect(store.claim).toHaveBeenCalledWith('gw-1', true, 10)
    const [message] = mailer.send.mock.calls[0] as [
      { to: string; subject: string; text: string; tags: string[] },
    ]
    expect(message.to).toBe('ada@gmail.com')
    expect(message.subject).toBe('Your password was changed')
    expect(message.text).toContain('Hi Ada,')
    expect(message.tags).toEqual(['security', 'password_changed'])
    expect(store.sent).toHaveBeenCalledWith('e1', 'gw-1', '<m1>', 'password_changed@1')
  })

  it('marks a test-mode email as a test', async () => {
    const store = fakeStore([
      email({
        kind: 'refund_sent',
        testMode: true,
        data: {
          order_id: 'o1',
          order_number: 'ND-1',
          amount_kobo: 100000,
          reason: 'duplicate_charge',
        },
      }),
    ])
    const mailer = fakeMailer()
    await sender(store, mailer, true).sendDue()
    expect((mailer.send.mock.calls[0] as [{ subject: string }])[0].subject).toMatch(/^\[Test\] /)
  })

  it('never mails a reserved address, even if one got past the database', async () => {
    const store = fakeStore([email({ toEmail: 'e2e-1@example.com' })])
    const mailer = fakeMailer()
    expect(await sender(store, mailer).sendDue()).toEqual({ sent: 0, failed: 0, skipped: 1 })
    expect(mailer.send).not.toHaveBeenCalled()
    expect(store.skipped).toHaveBeenCalledWith('e1', 'gw-1', 'reserved_address')
  })

  it('fails for good an email it cannot render — sending again would not help', async () => {
    const store = fakeStore([email({ kind: 'no_such_kind' }), email({ id: 'e2', data: {} })])
    const mailer = fakeMailer()
    expect(await sender(store, mailer).sendDue()).toEqual({ sent: 0, failed: 2, skipped: 0 })
    expect(mailer.send).not.toHaveBeenCalled()
    expect(store.failed).toHaveBeenCalledWith('e1', 'gw-1', 'unknown kind no_such_kind', true)
    expect(store.failed).toHaveBeenCalledWith(
      'e2',
      'gw-1',
      expect.stringMatching(/^bad data/),
      true,
    )
  })

  it('passes Brevo’s verdict on: a refusal is final, anything else is retried', async () => {
    const store = fakeStore([email(), email({ id: 'e2' })])
    const mailer = fakeMailer({
      send: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, permanent: true, error: 'HTTP 400 invalid_parameter' })
        .mockResolvedValueOnce({ ok: false, permanent: false, error: 'HTTP 503' }),
    })
    expect(await sender(store, mailer).sendDue()).toEqual({ sent: 0, failed: 2, skipped: 0 })
    expect(store.failed).toHaveBeenCalledWith('e1', 'gw-1', 'HTTP 400 invalid_parameter', true)
    expect(store.failed).toHaveBeenCalledWith('e2', 'gw-1', 'HTTP 503', false)
  })

  it('never logs an address', async () => {
    const store = fakeStore([email(), email({ id: 'e2', kind: 'no_such_kind' })])
    const mailer = fakeMailer({
      send: vi.fn(async () => ({ ok: false as const, permanent: false, error: 'HTTP 503' })),
    })
    await sender(store, mailer).sendDue()
    const logged = JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls])
    expect(logged).not.toContain('ada@gmail.com')
  })
})

describe('delivery checks (FR-NT3)', () => {
  it('records what Brevo says became of each notice', async () => {
    const store = fakeStore(
      [],
      [
        { id: 'e1', messageId: '<m1>', sentAt: new Date('2026-09-24T07:05:00Z') },
        { id: 'e2', messageId: '<m2>', sentAt: new Date('2026-09-24T07:05:00Z') },
      ],
    )
    const mailer = fakeMailer({
      delivery: vi.fn().mockResolvedValueOnce('delivered').mockResolvedValueOnce('bounced'),
    })
    expect(await sender(store, mailer).checkDeliveries()).toBe(2)
    expect(store.recordDelivery).toHaveBeenCalledWith('e1', 'delivered')
    expect(store.recordDelivery).toHaveBeenCalledWith('e2', 'bounced')
    expect(log.warn).toHaveBeenCalledWith({ emailId: 'e2' }, 'notice bounced')
  })

  it('counts a notice still being retried after three days as not delivered', async () => {
    const store = fakeStore(
      [],
      [{ id: 'e1', messageId: '<m1>', sentAt: new Date('2026-09-20T12:00:00Z') }],
    )
    const mailer = fakeMailer({ delivery: vi.fn(async () => 'deferred' as const) })
    await sender(store, mailer).checkDeliveries()
    expect(store.recordDelivery).toHaveBeenCalledWith('e1', 'bounced')
  })

  it('leaves a notice Brevo could not tell us about for the next check', async () => {
    const store = fakeStore([], [{ id: 'e1', messageId: '<m1>', sentAt: NOW }])
    const mailer = fakeMailer({
      delivery: vi.fn(async () => Promise.reject(new Error('HTTP 429'))),
    })
    expect(await sender(store, mailer).checkDeliveries()).toBe(0)
    expect(store.recordDelivery).not.toHaveBeenCalled()
  })
})

describe('the loops', () => {
  it('send and check on start, and stop cleanly', async () => {
    const store = fakeStore()
    const running = sender(store, fakeMailer())
    running.start()
    running.start()
    await running.stop()
    expect(store.claim).toHaveBeenCalledTimes(1)
    expect(store.deliveryDue).toHaveBeenCalledTimes(1)
  })

  it('keeps going after a failed run, and logs it', async () => {
    const store = fakeStore()
    store.claim.mockRejectedValueOnce(new Error('database unreachable'))
    const running = sender(store, fakeMailer())
    running.start()
    await running.stop()
    expect(log.error).toHaveBeenCalledWith({ err: 'database unreachable' }, 'email sending failed')
  })
})
