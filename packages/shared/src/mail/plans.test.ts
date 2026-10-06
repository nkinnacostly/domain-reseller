import { describe, expect, it } from 'vitest'
import {
  type AccountCaps,
  budgetAllowance,
  capLevel,
  effectiveCaps,
  isPaidPlan,
  nextWarmupDay,
  warmupCap,
} from './plans'

const STARTER = { dailyCap: 5000, monthlyCap: 50000 }
const FREE = { dailyCap: 100, monthlyCap: 3000 }
const SETTINGS = { sandboxDailyCap: 100, warmupStartCap: 1000 }
const ACTIVE: AccountCaps = {
  state: 'active',
  warmupDay: null,
  dailyCapOverride: null,
  monthlyCapOverride: null,
}

describe('caps (§7.2, §7.3, §8) — the same table as mail.effective_caps', () => {
  it('the sandbox sends 100 a day, whatever the plan', () => {
    expect(effectiveCaps(STARTER, { ...ACTIVE, state: 'sandbox' }, SETTINGS)).toEqual({
      daily: 100,
      monthly: 50000,
    })
  })

  it('warm-up starts at 1,000 and doubles each day, up to the plan', () => {
    const day = (warmupDay: number) =>
      effectiveCaps(STARTER, { ...ACTIVE, warmupDay }, SETTINGS).daily
    expect([0, 1, 2, 3, 60].map(day)).toEqual([1000, 2000, 4000, 5000, 5000])
    expect(warmupCap(2, 1000)).toBe(4000)
    expect(warmupCap(-3, 1000)).toBe(1000)
    expect(warmupCap(99, 1)).toBe(2 ** 30)
  })

  it('a plan below the warm-up start keeps its own cap', () => {
    expect(effectiveCaps(FREE, { ...ACTIVE, warmupDay: 0 }, SETTINGS)).toEqual({
      daily: 100,
      monthly: 3000,
    })
  })

  it('an admin’s override replaces the plan and ends warm-up', () => {
    expect(
      effectiveCaps(STARTER, { ...ACTIVE, warmupDay: 0, dailyCapOverride: 7 }, SETTINGS).daily,
    ).toBe(7)
    expect(effectiveCaps(STARTER, { ...ACTIVE, monthlyCapOverride: 10 }, SETTINGS)).toEqual({
      daily: 10,
      monthly: 10,
    })
  })

  it('paused and closed accounts send nothing', () => {
    expect(effectiveCaps(STARTER, { ...ACTIVE, state: 'paused' }, SETTINGS)).toEqual({
      daily: 0,
      monthly: 0,
    })
    expect(effectiveCaps(STARTER, { ...ACTIVE, state: 'closed' }, SETTINGS)).toEqual({
      daily: 0,
      monthly: 0,
    })
  })
})

describe('warm-up days (§7.3)', () => {
  it('a clean day moves on; a day over either rate does not; an empty day proves nothing', () => {
    expect(nextWarmupDay(2, { sent: 1000, bounced: 19, complained: 0 })).toBe(3)
    expect(nextWarmupDay(2, { sent: 1000, bounced: 20, complained: 0 })).toBe(2)
    expect(nextWarmupDay(2, { sent: 10000, bounced: 0, complained: 5 })).toBe(2)
    expect(nextWarmupDay(2, { sent: 10000, bounced: 0, complained: 4 })).toBe(3)
    expect(nextWarmupDay(2, { sent: 0, bounced: 0, complained: 0 })).toBe(2)
  })
})

describe('the SES account’s shared budget (§4.4)', () => {
  it('no account takes more than half of what the others leave', () => {
    expect(budgetAllowance(49000, 0, 0)).toBe(24500)
    expect(budgetAllowance(49000, 40000, 0)).toBe(4500)
    expect(budgetAllowance(49000, 30000, 20000)).toBe(0)
    expect(budgetAllowance(40, 30, 0)).toBe(5)
    expect(budgetAllowance(40, 35, 5)).toBe(0)
  })

  it('never past the budget itself', () => {
    expect(budgetAllowance(10, 10, 0)).toBe(0)
    expect(budgetAllowance(10, 12, 0)).toBe(0)
  })
})

describe('cap levels (§8)', () => {
  it('warns at 80%, stops at 100%', () => {
    expect(capLevel(79, 100)).toBe('ok')
    expect(capLevel(80, 100)).toBe('warning')
    expect(capLevel(100, 100)).toBe('reached')
    expect(capLevel(0, 0)).toBe('reached')
    expect(isPaidPlan(0)).toBe(false)
    expect(isPaidPlan(2000000)).toBe(true)
  })
})
