import { describe, expect, it } from 'vitest'
import {
  evaluateStatus,
  formatStatusTime,
  GATEWAY_FRESH_MINUTES,
  type PublicStatus,
  parsePublicStatus,
  REGISTRY_FRESH_HOURS,
} from '../lib/status'

const CHECKED = '2026-09-24T12:00:00.000Z'
const ago = (ms: number) => new Date(new Date(CHECKED).getTime() - ms).toISOString()
const MINUTE = 60_000

const healthy = (overrides: Partial<PublicStatus> = {}): PublicStatus => ({
  checkedAt: CHECKED,
  gatewaySeenAt: ago(4 * MINUTE),
  registryCheckedAt: ago(40 * MINUTE),
  ordersDelayed: false,
  ...overrides,
})

const line = (status: PublicStatus, id: string) => {
  const found = evaluateStatus(status).lines.find((l) => l.id === id)
  if (!found) throw new Error(`no ${id} line`)
  return found
}

describe('parsePublicStatus', () => {
  it('reads what public_status() returns', () => {
    expect(
      parsePublicStatus({
        checked_at: '2026-09-24T09:35:46.478926+00:00',
        gateway_seen_at: '2026-09-24T09:28:32.221001+00:00',
        registry_checked_at: null,
        orders_delayed: false,
      }),
    ).toEqual({
      checkedAt: '2026-09-24T09:35:46.478Z',
      gatewaySeenAt: '2026-09-24T09:28:32.221Z',
      registryCheckedAt: null,
      ordersDelayed: false,
    })
  })

  it('treats an unreadable time as none on record', () => {
    expect(
      parsePublicStatus({
        checked_at: CHECKED,
        gateway_seen_at: 'yesterday',
        registry_checked_at: null,
        orders_delayed: false,
      })?.gatewaySeenAt,
    ).toBeNull()
  })

  it('refuses anything else, rather than guessing a status', () => {
    expect(parsePublicStatus(null)).toBeNull()
    expect(parsePublicStatus({ checked_at: CHECKED })).toBeNull()
    expect(
      parsePublicStatus({
        checked_at: 'not a time',
        gateway_seen_at: null,
        registry_checked_at: null,
        orders_delayed: false,
      }),
    ).toBeNull()
  })
})

describe('evaluateStatus', () => {
  it('is operational when everything checked in on time', () => {
    const report = evaluateStatus(healthy())
    expect(report.overall).toBe('operational')
    expect(report.checkedAt).toBe(CHECKED)
    expect(report.lines.map((l) => [l.id, l.state])).toEqual([
      ['provisioning', 'operational'],
      ['orders', 'operational'],
      ['registry', 'operational'],
    ])
  })

  it(`calls the gateway delayed once it has been silent over ${GATEWAY_FRESH_MINUTES} minutes`, () => {
    expect(
      line(healthy({ gatewaySeenAt: ago(GATEWAY_FRESH_MINUTES * MINUTE) }), 'provisioning').state,
    ).toBe('operational')

    const late = line(
      healthy({ gatewaySeenAt: ago((GATEWAY_FRESH_MINUTES + 1) * MINUTE) }),
      'provisioning',
    )
    expect(late.state).toBe('delayed')
    expect(late.detail).toMatch(
      /^Delayed — paid orders wait in a queue and are processed when it returns\. It last checked in at 12:44 on 24 September 2026\.$/,
    )
  })

  it('says so when the gateway has never checked in', () => {
    const never = line(healthy({ gatewaySeenAt: null }), 'provisioning')
    expect(never.state).toBe('delayed')
    expect(never.detail).toMatch(/We have no record of it checking in\.$/)
  })

  it('reads a heartbeat ahead of the database clock as fresh', () => {
    expect(line(healthy({ gatewaySeenAt: '2026-09-24T12:00:05.000Z' }), 'provisioning').state).toBe(
      'operational',
    )
  })

  it('reports delayed orders as delayed, overall too', () => {
    const report = evaluateStatus(healthy({ ordersDelayed: true }))
    expect(report.overall).toBe('delayed')
    expect(line(healthy({ ordersDelayed: true }), 'orders').detail).toMatch(
      /stay in the queue until they are processed/,
    )
    expect(line(healthy(), 'orders').detail).toBe('None is waiting longer than usual.')
  })

  it(`calls registry checks delayed after ${REGISTRY_FRESH_HOURS} hours without one`, () => {
    const fresh = line(
      healthy({ registryCheckedAt: ago(REGISTRY_FRESH_HOURS * 60 * MINUTE) }),
      'registry',
    )
    expect(fresh.state).toBe('operational')
    expect(fresh.detail).toBe('The last check finished at 11:00 on 24 September 2026.')

    const stale = line(
      healthy({ registryCheckedAt: ago(REGISTRY_FRESH_HOURS * 60 * MINUTE + MINUTE) }),
      'registry',
    )
    expect(stale.state).toBe('delayed')
    expect(stale.detail).toMatch(/^Delayed — the last check finished at 10:59 on/)
    expect(stale.detail).toMatch(/Your domains are not affected/)
  })

  it('says so when no registry check has ever finished', () => {
    expect(line(healthy({ registryCheckedAt: null }), 'registry').detail).toMatch(
      /^Delayed — we have no record of a finished check\./,
    )
  })
})

describe('formatStatusTime', () => {
  it('gives the time and date in Lagos', () => {
    expect(formatStatusTime('2026-09-24T23:30:00Z')).toBe('00:30 on 25 September 2026')
  })
})
