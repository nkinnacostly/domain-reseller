import { describe, expect, it, vi } from 'vitest'
import { NoAnswer } from '../lib/http'
import { formatAlerts } from './format'
import { createAlertMonitor } from './monitor'
import { type AlertStore, type DueAlert, toDueAlerts } from './store'
import { createTelegramNotifier, TELEGRAM_MAX_CHARS } from './telegram'

const alert = (overrides: Partial<DueAlert> = {}): DueAlert => ({
  id: 1,
  type: 'new',
  severity: 'critical',
  kind: 'refund_needs_attention',
  summary:
    'Refund of ₦19,672.50 for order ND-001050 (getpaid.com) is needs attention — REGISTERED_AT_REGISTRY',
  firstSeenAt: '2026-09-24T10:05:00Z',
  ...overrides,
})

describe('formatAlerts', () => {
  it('leads with an urgent header when anything open is critical', () => {
    const [message] = formatAlerts([alert()], 'live', 'MyDomainsHub')
    expect(message?.text.split('\n')[0]).toBe('🚨 MyDomainsHub (live)')
    expect(message?.text).toContain('🔴 Refund of ₦19,672.50')
  })

  it('groups new, still open and cleared, critical first', () => {
    const [message] = formatAlerts(
      [
        alert({ id: 1, type: 'resolved', summary: 'Order ND-1 settled' }),
        alert({ id: 2, severity: 'warning', summary: 'Balance low' }),
        alert({ id: 3, summary: 'Refund stuck' }),
        alert({ id: 4, type: 'reminder', summary: 'Job stuck' }),
      ],
      'test',
      'MyDomainsHub',
    )
    const text = message?.text ?? ''
    expect(text.indexOf('New:')).toBeLessThan(text.indexOf('Still open:'))
    expect(text.indexOf('Still open:')).toBeLessThan(text.indexOf('Cleared:'))
    expect(text.indexOf('🔴 Refund stuck')).toBeLessThan(text.indexOf('🟠 Balance low'))
    expect(text).toContain('✅ Order ND-1 settled')
    // Reminders say how long; the time is Lagos time.
    expect(text).toMatch(/Job stuck \(open since 24 Sept?, 11:05\)/)
    expect(message?.alertIds.sort()).toEqual([2, 3, 4])
    expect(message?.resolvedIds).toEqual([1])
  })

  it('is informational when nothing open is critical', () => {
    const [message] = formatAlerts([alert({ severity: 'warning' })], 'test', 'X')
    expect(message?.text.startsWith('ℹ️ X (test)')).toBe(true)
  })

  it('splits into messages Telegram accepts, each knowing its alerts', () => {
    const many = Array.from({ length: 80 }, (_, index) =>
      alert({ id: index + 1, summary: `Registry check: domain-${index}.com — ${'x'.repeat(80)}` }),
    )
    const messages = formatAlerts(many, 'live', 'MyDomainsHub')
    expect(messages.length).toBeGreaterThan(1)
    for (const message of messages)
      expect(message.text.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS)
    expect(messages.flatMap((message) => message.alertIds).sort((a, b) => a - b)).toEqual(
      many.map((item) => item.id),
    )
  })

  it('says nothing when nothing is due', () => {
    expect(formatAlerts([], 'live', 'X')).toEqual([])
  })
})

describe('Telegram delivery', () => {
  const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'

  it('posts plain text to the chat and reports success', async () => {
    const request = vi.fn(async () => ({ status: 200, body: { ok: true } }))
    const notifier = createTelegramNotifier({
      token: TOKEN,
      chatId: '-1001',
      log: { warn: vi.fn() },
      request,
    })
    expect(await notifier.send('hello')).toBe(true)
    expect(request).toHaveBeenCalledWith(
      `https://api.telegram.org/bot${TOKEN}/sendMessage`,
      expect.objectContaining({
        method: 'POST',
        body: { chat_id: '-1001', text: 'hello', disable_web_page_preview: true },
      }),
    )
  })

  it('reports a refusal without ever logging the token', async () => {
    const log = { warn: vi.fn() }
    const request = vi.fn(async () => ({
      status: 429,
      body: { ok: false, description: 'Too Many Requests: retry after 5' },
    }))
    const notifier = createTelegramNotifier({ token: TOKEN, chatId: '1', log, request })
    expect(await notifier.send('hello')).toBe(false)
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(TOKEN)
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 429 }),
      expect.any(String),
    )
  })

  it('reports no answer as not delivered', async () => {
    const log = { warn: vi.fn() }
    const request = vi.fn(async () => {
      throw new NoAnswer(`connect failed to https://api.telegram.org/bot${TOKEN}`)
    })
    const notifier = createTelegramNotifier({ token: TOKEN, chatId: '1', log, request })
    expect(await notifier.send('hello')).toBe(false)
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(TOKEN)
  })

  it('trims a message to Telegram’s limit', async () => {
    const request = vi.fn(async () => ({ status: 200, body: { ok: true } }))
    const notifier = createTelegramNotifier({
      token: TOKEN,
      chatId: '1',
      log: { warn: vi.fn() },
      request,
    })
    await notifier.send('x'.repeat(5000))
    const body = (request.mock.calls[0] as unknown as [string, { body: { text: string } }])[1].body
    expect(body.text).toHaveLength(TELEGRAM_MAX_CHARS)
  })
})

function fakeStore(due: DueAlert[]) {
  return {
    heartbeat: vi.fn(async () => undefined),
    recordBalance: vi.fn(async () => undefined),
    sync: vi.fn(async () => due),
    markNotified: vi.fn(async () => undefined),
  } satisfies AlertStore
}

describe('the alert monitor', () => {
  const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

  it('beats, syncs, delivers and marks only what was delivered', async () => {
    const store = fakeStore([alert({ id: 7 }), alert({ id: 8, type: 'resolved' })])
    const notifier = { send: vi.fn(async () => true) }
    const monitor = createAlertMonitor({
      store,
      notifier,
      testMode: false,
      everyMs: 60_000,
      log: log(),
      heartbeatName: 'gateway:production',
    })
    expect(await monitor.runOnce()).toBe(2)
    expect(store.heartbeat).toHaveBeenCalledWith('gateway:production', false, expect.any(Object))
    expect(store.sync).toHaveBeenCalledWith(false)
    expect(store.markNotified).toHaveBeenCalledWith([7], [8])
  })

  it('leaves undelivered alerts unmarked, to try again', async () => {
    const store = fakeStore([alert({ id: 7 })])
    const notifier = { send: vi.fn(async () => false) }
    const logs = log()
    const monitor = createAlertMonitor({
      store,
      notifier,
      testMode: false,
      everyMs: 60_000,
      log: logs,
      heartbeatName: 'g',
    })
    expect(await monitor.runOnce()).toBe(0)
    expect(store.markNotified).not.toHaveBeenCalled()
    expect(logs.warn).toHaveBeenCalled()
  })

  it('with no channel, logs ids and kinds only — no summaries — and marks them', async () => {
    const store = fakeStore([alert({ id: 7 })])
    const logs = log()
    const monitor = createAlertMonitor({
      store,
      notifier: null,
      testMode: true,
      everyMs: 60_000,
      log: logs,
      heartbeatName: 'g',
    })
    await monitor.runOnce()
    expect(logs.error).toHaveBeenCalledWith(
      { alertId: 7, kind: 'refund_needs_attention', type: 'new' },
      expect.any(String),
    )
    expect(JSON.stringify(logs.error.mock.calls)).not.toContain('getpaid.com')
    expect(store.markNotified).toHaveBeenCalledWith([7], [])
  })

  it('records the supplier balance at most once per interval', async () => {
    const store = fakeStore([])
    let clock = new Date('2026-09-24T12:00:00Z').getTime()
    const readBalanceUsd = vi.fn(async () => 42.5)
    const monitor = createAlertMonitor({
      store,
      notifier: null,
      testMode: false,
      everyMs: 60_000,
      log: log(),
      heartbeatName: 'g',
      readBalanceUsd,
      balanceEveryMs: 30 * 60_000,
      now: () => new Date(clock),
    })
    await monitor.runOnce()
    clock += 5 * 60_000
    await monitor.runOnce()
    clock += 30 * 60_000
    await monitor.runOnce()
    expect(readBalanceUsd).toHaveBeenCalledTimes(2)
    expect(store.recordBalance).toHaveBeenCalledWith(false, 42.5)
  })

  it('keeps going when the heartbeat or the balance cannot be written', async () => {
    const store = fakeStore([])
    store.heartbeat.mockRejectedValueOnce(new Error('db'))
    const logs = log()
    const monitor = createAlertMonitor({
      store,
      notifier: null,
      testMode: false,
      everyMs: 60_000,
      log: logs,
      heartbeatName: 'g',
      readBalanceUsd: async () => {
        throw new Error('supplier down')
      },
    })
    await monitor.runOnce()
    expect(store.sync).toHaveBeenCalled()
    expect(logs.error).toHaveBeenCalled()
    expect(logs.warn).toHaveBeenCalled()
  })

  it('starts and stops, surviving a failed pass', async () => {
    const store = fakeStore([])
    store.sync.mockRejectedValueOnce(new Error('db'))
    const logs = log()
    const monitor = createAlertMonitor({
      store,
      notifier: null,
      testMode: false,
      everyMs: 60_000,
      log: logs,
      heartbeatName: 'g',
    })
    monitor.start()
    monitor.start()
    await monitor.stop()
    expect(logs.error).toHaveBeenCalledWith(expect.any(Object), 'alert check failed')
  })
})

describe('reading due alerts', () => {
  it('parses what sync_alerts returns', () => {
    expect(
      toDueAlerts([
        {
          id: '12',
          type: 'reminder',
          severity: 'warning',
          kind: 'float_low',
          summary: 'Balance low',
          first_seen_at: '2026-09-24T10:00:00Z',
        },
      ]),
    ).toEqual([
      {
        id: 12,
        type: 'reminder',
        severity: 'warning',
        kind: 'float_low',
        summary: 'Balance low',
        firstSeenAt: '2026-09-24T10:00:00Z',
      },
    ])
  })

  it('treats nothing as no alerts, and refuses a shape it does not know', () => {
    expect(toDueAlerts(null)).toEqual([])
    expect(() => toDueAlerts([{ id: 1, type: 'panic' }])).toThrow()
  })
})
