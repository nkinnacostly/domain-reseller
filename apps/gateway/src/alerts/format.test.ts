import { describe, expect, it } from 'vitest'
import { formatAlerts } from './format'
import type { DueAlert } from './store'
import { TELEGRAM_MAX_CHARS } from './telegram'

/** ADMIN-SPEC §4.5: each Telegram line links to where the alert is worked. */

const alert = (overrides: Partial<DueAlert> = {}): DueAlert => ({
  id: 1,
  type: 'new',
  severity: 'critical',
  kind: 'job_needs_attention',
  summary: 'Registration of example.com needs a person (SUPPLIER_TIMEOUT)',
  firstSeenAt: '2026-10-02T10:05:00Z',
  key: 'job:8dbd7ea2-c535-4a4a-a091-e202d9185a20',
  ...overrides,
})

describe('admin links in alerts', () => {
  it('adds the dashboard page to each line when the site is known', () => {
    const [message] = formatAlerts(
      [alert()],
      'live',
      'MyDomainsHub',
      'https://www.mydomainshub.com/',
    )
    expect(message?.text).toContain(
      '🔴 Registration of example.com needs a person (SUPPLIER_TIMEOUT) — https://www.mydomainshub.com/admin/queue/jobs/8dbd7ea2-c535-4a4a-a091-e202d9185a20',
    )
  })

  it('adds nothing without a site or a key, and never to a cleared line', () => {
    expect(formatAlerts([alert()], 'live', 'X', undefined)[0]?.text).not.toContain('/admin')
    const { key: _key, ...unkeyed } = alert()
    expect(formatAlerts([unkeyed], 'live', 'X', 'https://x.test')[0]?.text).not.toContain('/admin')
    expect(
      formatAlerts([alert({ type: 'resolved' })], 'live', 'X', 'https://x.test')[0]?.text,
    ).not.toContain('/admin')
  })

  it('keeps every message within Telegram’s budget with links on', () => {
    const many = Array.from({ length: 120 }, (_, index) =>
      alert({
        id: index + 1,
        summary: `Refund stuck for order ND-${index} ${'x'.repeat(60)}`,
        key: `refund:8dbd7ea2-c535-4a4a-a091-e202d9185a2${index % 10}`,
      }),
    )
    const messages = formatAlerts(many, 'live', 'MyDomainsHub', 'https://www.mydomainshub.com')
    expect(messages.length).toBeGreaterThan(1)
    for (const message of messages)
      expect(message.text.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS)
    expect(messages.flatMap((message) => message.alertIds)).toHaveLength(120)
  })
})
