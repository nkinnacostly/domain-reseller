import { describe, expect, it } from 'vitest'
import {
  greeting,
  initials,
  nextMonths,
  relativeDays,
  summarize,
  todayLine,
} from '../lib/dashboard'
import type { PortfolioDomain } from '../lib/portfolio'

// 24 Sept 2026, 10:00 in Lagos (UTC+1).
const NOW = new Date('2026-09-24T09:00:00Z')
const DAY = 86_400_000

function domain(name: string, overrides: Partial<PortfolioDomain> = {}): PortfolioDomain {
  return {
    id: name,
    domainName: name,
    tld: 'com',
    source: 'registration',
    testMode: false,
    status: 'active',
    expiresAt: new Date(NOW.getTime() + 200 * DAY).toISOString(),
    autoRenew: true,
    privacyEnabled: false,
    transferLock: true,
    delegationStatus: 'verified',
    nameservers: null,
    pendingNameservers: null,
    labels: [],
    ...overrides,
  }
}

const inDays = (days: number) => new Date(NOW.getTime() + days * DAY + 3_600_000).toISOString()

describe('summarize (FR-P1)', () => {
  const portfolio = [
    domain('later.com'),
    domain('soon.com', { expiresAt: inDays(5), autoRenew: false, delegationStatus: 'undelegated' }),
    domain('month.com', { expiresAt: inDays(20), delegationStatus: 'pending' }),
    domain('gone.com', {
      status: 'expired_grace',
      expiresAt: inDays(-6),
      autoRenew: false,
      delegationStatus: 'failed',
    }),
    domain('waiting.com', { status: 'pending', expiresAt: null, delegationStatus: 'undelegated' }),
    domain('failed.com', { status: 'registration_failed', expiresAt: null }),
  ]
  const summary = summarize(
    portfolio,
    [{ status: 'awaiting_payment' }, { status: 'completed' }, { status: 'awaiting_payment' }],
    NOW,
  )

  it('counts every domain, and the active ones', () => {
    expect(summary.total).toBe(6)
    expect(summary.active).toBe(3)
  })

  it('counts what is due exactly as the expiry view lists it, expired included', () => {
    expect(summary.dueWithin30).toBe(3)
    expect(summary.dueWithin7).toBe(2)
  })

  it('measures auto-renew over the domains still ours to renew', () => {
    // later, soon, month, gone are held; soon and gone renew by hand.
    expect(summary.held).toBe(4)
    expect(summary.autoRenewOff).toBe(2)
    expect(summary.autoRenewShare).toBe(50)
  })

  it('sorts held domains by where they point, and links the first one not pointed', () => {
    expect(summary.nameservers).toEqual({ working: 1, waiting: 1, notSet: 2 })
    expect(summary.firstNotPointed).toBe('gone.com')
  })

  it('counts a change still waiting at the registry as waiting', () => {
    const changing = summarize([domain('a.com', { pendingNameservers: ['ns1.x.com'] })], [], NOW)
    expect(changing.nameservers).toEqual({ working: 0, waiting: 1, notSet: 0 })
  })

  it('buckets renewals into the next six months, this one first', () => {
    expect(summary.renewalsByMonth.map((month) => month.label)).toEqual([
      'Sept',
      'Oct',
      'Nov',
      'Dec',
      'Jan',
      'Feb',
    ])
    // gone.com (18 Sept, in grace) and soon.com (29 Sept) are this month;
    // month.com (14 Oct) next; later.com is April, past the window.
    expect(summary.renewalsByMonth.map((month) => month.count)).toEqual([2, 1, 0, 0, 0, 0])
    expect(summary.renewalsAhead).toBe(3)
  })

  it('lists held domains soonest first, and only those with a date', () => {
    expect(summary.upcoming.map((row) => row.domainName)).toEqual([
      'gone.com',
      'soon.com',
      'month.com',
      'later.com',
    ])
  })

  it('counts orders still waiting for payment', () => {
    expect(summary.awaitingPayment).toBe(2)
  })

  it('says nothing about shares with nothing to measure', () => {
    const empty = summarize([], [], NOW)
    expect(empty.autoRenewShare).toBeNull()
    expect(empty.firstNotPointed).toBeNull()
    expect(empty.renewalsAhead).toBe(0)
    expect(empty.upcoming).toEqual([])
  })
})

describe('nextMonths', () => {
  it('rolls over the year', () => {
    expect(nextMonths(new Date('2026-11-30T23:30:00Z'), 3).map((month) => month.key)).toEqual([
      '2026-12',
      '2027-01',
      '2027-02',
    ])
  })
})

describe('greeting', () => {
  it.each([
    ['2026-09-24T05:00:00Z', 'Good morning'],
    ['2026-09-24T10:59:00Z', 'Good morning'],
    ['2026-09-24T11:00:00Z', 'Good afternoon'],
    ['2026-09-24T16:00:00Z', 'Good evening'],
    ['2026-09-24T23:30:00Z', 'Good morning'],
  ])('at %s UTC it is "%s" in Lagos', (at, expected) => {
    expect(greeting(new Date(at))).toBe(expected)
  })
})

describe('todayLine', () => {
  it('names the day in Lagos', () => {
    expect(todayLine(NOW)).toBe('It’s Thursday 24 September 2026')
    expect(todayLine(new Date('2026-09-24T23:30:00Z'))).toBe('It’s Friday 25 September 2026')
  })
})

describe('relativeDays', () => {
  it('reads naturally either side of today', () => {
    expect(relativeDays(inDays(12), NOW)).toBe('in 12 days')
    expect(relativeDays(inDays(1), NOW)).toBe('in 1 day')
    expect(relativeDays(inDays(0), NOW)).toBe('today')
    expect(relativeDays(inDays(-6), NOW)).toBe('6 days ago')
  })
})

describe('initials', () => {
  it('takes two from the name, else the email', () => {
    expect(initials('Ada Okafor Nneka', 'a@b.co')).toBe('AO')
    expect(initials('  ', 'test@example.com')).toBe('T')
  })
})
