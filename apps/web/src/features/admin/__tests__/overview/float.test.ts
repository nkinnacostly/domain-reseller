import { describe, expect, it } from 'vitest'
import {
  aboutDays,
  paceDays,
  RUNWAY_CRITICAL_DAYS,
  RUNWAY_WARNING_DAYS,
  runwayLine,
  runwayTone,
  snapshotLine,
  targetKnown,
  targetLine,
} from '@/features/admin/lib/overview-float'
import { floatState, minutesAgo, NOW } from './fixtures'

describe('the runway, in words (§5.2 B1)', () => {
  it('known: about N days at the 7-day spend, with the 30-day pace', () => {
    expect(runwayLine(floatState(), NOW)).toEqual({
      tone: 'ok',
      text: "About 12 days at the last 7 days' spend (30-day pace: 14 days)",
    })
  })

  it('warns under 10 days of cover and pages under 3 (FR-FLOAT-2)', () => {
    expect(runwayTone(RUNWAY_WARNING_DAYS)).toBe('ok')
    expect(runwayTone(9.9)).toBe('warning')
    expect(runwayTone(RUNWAY_CRITICAL_DAYS)).toBe('warning')
    expect(runwayTone(2.9)).toBe('danger')
    expect(runwayLine(floatState({ runwayDays: 0.4 }), NOW)).toMatchObject({
      tone: 'danger',
      text: expect.stringMatching(/^Under a day at the last 7 days' spend/),
    })
  })

  it('stale: unknown, with when the ledger was last read and the runway then', () => {
    const stale = floatState({
      burnState: 'stale',
      runwayDays: null,
      ledgerReadAt: '2026-10-03T13:15:00Z',
      lastKnownRunway: { days: 8.2, at: '2026-10-03T13:15:00Z' },
    })
    expect(runwayLine(stale, new Date('2026-10-03T18:00:00Z'))).toEqual({
      tone: 'warning',
      text: 'Runway unknown — the supplier ledger was last read at 14:15 WAT (then about 8 days)',
    })
    // Another day: the date too, so "14:15" is never yesterday's.
    expect(runwayLine(stale, new Date('2026-10-04T18:00:00Z')).text).toBe(
      'Runway unknown — the supplier ledger was last read at 3 Oct 2026, 14:15 WAT (then about 8 days)',
    )
    expect(runwayLine({ ...stale, lastKnownRunway: null }, NOW).text).not.toContain('then')
    expect(runwayLine({ ...stale, ledgerReadAt: null }, NOW).text).toBe(
      'Runway unknown — the supplier ledger has not been read on this side',
    )
  })

  it('short history: unknown until the mirror holds 7 days', () => {
    expect(runwayLine(floatState({ burnState: 'short_history', runwayDays: null }), NOW)).toEqual({
      tone: 'neutral',
      text: 'Runway unknown — the supplier ledger holds under 7 days of history',
    })
  })

  it('no spend: says so rather than an endless runway', () => {
    expect(runwayLine(floatState({ burn7dCents: 0, runwayDays: null }), NOW)).toEqual({
      tone: 'ok',
      text: 'No spend in the last 7 days',
    })
  })

  it('short-by: work already paid for that the balance cannot cover comes first', () => {
    const short = floatState({
      balanceCents: 1000,
      committedCents: 2250,
      shortByCents: 1250,
      runwayDays: 0,
      burnState: 'stale',
    })
    expect(runwayLine(short, NOW)).toEqual({
      tone: 'danger',
      text: 'Short by $12.50 for work already paid for',
    })
  })

  it('no snapshot: nothing to work a runway from', () => {
    expect(runwayLine(floatState({ balanceCents: null }), NOW)).toEqual({
      tone: 'neutral',
      text: 'No balance snapshot on this side yet',
    })
  })

  it('counts days whole: under a day, one day, many', () => {
    expect(aboutDays(0.9)).toBe('under a day')
    expect(aboutDays(1.4)).toBe('about 1 day')
    expect(aboutDays(12.5)).toBe('about 13 days')
  })

  it('works the 30-day pace from integer cents, never below zero', () => {
    expect(paceDays(floatState())).toBeCloseTo(14.46, 2)
    expect(paceDays(floatState({ committedCents: 5000 }))).toBe(0)
    expect(paceDays(floatState({ burn30dCents: 0 }))).toBeNull()
    expect(paceDays(floatState({ balanceCents: null }))).toBeNull()
    expect(runwayLine(floatState({ burn30dCents: 0 }), NOW).text).toBe(
      "About 12 days at the last 7 days' spend",
    )
  })
})

describe('the 21-day target (FR-FLOAT-4)', () => {
  it('keeps 21 days of spend and says how much to top up', () => {
    expect(targetLine(floatState())).toEqual({
      tone: 'warning',
      text: 'Keep $75.60 (21 days of spend); top up $32.22.',
    })
  })

  it('names what is already paid for, which the target includes', () => {
    expect(
      targetLine(floatState({ committedCents: 1131, target21dCents: 8691, topUpToTargetCents: 0 })),
    ).toEqual({
      tone: 'ok',
      text: 'Keep $86.91 (21 days of spend plus $11.31 already paid for); no top-up needed.',
    })
  })

  it('qualifies the spend when the ledger is stale or short', () => {
    expect(targetLine(floatState({ burnState: 'stale' })).text).toContain(
      '21 days of spend, as of the last ledger read',
    )
    expect(targetLine(floatState({ burnState: 'short_history' })).text).toContain(
      '21 days of spend, from under 7 days of ledger history',
    )
  })

  it('is not known before the ledger has ever been read on the side', () => {
    const never = floatState({ burnState: 'stale', ledgerReadAt: null, balanceCents: null })
    expect(targetKnown(never)).toBe(false)
    expect(targetKnown(floatState({ burnState: 'stale' }))).toBe(true)
    expect(targetLine(never)).toEqual({
      tone: 'neutral',
      text: 'Not known until the supplier ledger has been read on this side.',
    })
  })

  it('does not guess a top-up without a balance', () => {
    expect(targetLine(floatState({ balanceCents: null, topUpToTargetCents: null }))).toEqual({
      tone: 'neutral',
      text: 'Keep $75.60 (21 days of spend). With no balance snapshot, the top-up is not known.',
    })
  })
})

describe('when the balance was taken', () => {
  it('gives the time today, the date on another day, and nothing without one', () => {
    expect(snapshotLine({ takenAt: minutesAgo(10) }, NOW)).toBe('Snapshot 09:50 WAT')
    expect(snapshotLine({ takenAt: '2026-10-01T09:00:00Z' }, NOW)).toBe(
      'Snapshot 1 Oct 2026, 10:00 WAT',
    )
    expect(snapshotLine({ takenAt: null }, NOW)).toBeNull()
  })
})
