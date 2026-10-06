import { describe, expect, it } from 'vitest'
import {
  cheapestPaid,
  formatCount,
  freePlan,
  isFree,
  planFeatures,
  planPrice,
  planSummary,
  toCatalogue,
} from '../lib/plans'
import { ROWS } from './fixtures'

describe('the plans the pricing page shows (MAIL-SPEC §8)', () => {
  it('leaves out a plan that is not offered — Scale, while the SES quota cannot carry it', () => {
    const { plans } = toCatalogue(ROWS)
    expect(plans.map((plan) => plan.code)).toEqual(['free', 'starter', 'pro'])
    expect(plans.some((plan) => plan.name === 'Scale')).toBe(false)
  })

  it('dates the page by the newest offered row, ignoring rows it does not show', () => {
    expect(toCatalogue(ROWS).updatedAt).toBe('2026-10-06T11:00:00.000Z')
    expect(toCatalogue([]).updatedAt).toBeNull()
  })

  it('orders equal sort orders by price', () => {
    const rows = ROWS.filter((row) => row.is_offered).map((row) => ({ ...row, sort_order: 0 }))
    expect(toCatalogue(rows).plans.map((plan) => plan.code)).toEqual(['free', 'starter', 'pro'])
  })

  it('keeps every number from the row, in kobo (N5, N5b)', () => {
    const starter = toCatalogue(ROWS).plans[1]
    expect(starter).toEqual({
      code: 'starter',
      name: 'Starter',
      priceKobo: 2_000_000,
      monthlyCap: 50_000,
      dailyCap: 5000,
      maxDomains: 5,
      maxMembers: 3,
      logRetentionDays: 30,
    })
  })

  it('words a plan: price, caps, domains, members, retention', () => {
    const [free, starter] = toCatalogue(ROWS).plans
    if (!free || !starter) throw new Error('fixture')
    expect(planPrice(starter)).toMatch(/^₦\s?20,000$/)
    expect(planPrice(free)).toMatch(/^₦\s?0$/)
    expect(isFree(free)).toBe(true)
    expect(planFeatures(free)).toEqual([
      '3,000 emails a month',
      'Up to 100 a day',
      '1 sending domain',
      '1 team member',
      'Email log kept 7 days',
    ])
    expect(planFeatures(starter)).toContain('5 sending domains')
    expect(planFeatures(starter)).toContain('3 team members')
    expect(planSummary(free)).toBe(
      'Free: Free. 3,000 emails a month; Up to 100 a day; 1 sending domain; 1 team member; Email log kept 7 days.',
    )
    expect(planSummary(starter)).toMatch(/^Starter: ₦\s?20,000 a month before VAT\. 50,000 emails/)
  })

  it('a plan with one log day and one email says so in the singular', () => {
    const one = { ...toCatalogue(ROWS).plans[0], monthlyCap: 1, logRetentionDays: 1 }
    expect(planFeatures(one as never)).toEqual(
      expect.arrayContaining(['1 email a month', 'Email log kept 1 day']),
    )
  })

  it('finds the free plan and the cheapest paid one, or none', () => {
    const { plans } = toCatalogue(ROWS)
    expect(freePlan(plans)?.code).toBe('free')
    expect(cheapestPaid(plans)?.code).toBe('starter')
    expect(freePlan([])).toBeNull()
    expect(cheapestPaid(plans.filter(isFree))).toBeNull()
    expect(formatCount(150_000)).toBe('150,000')
  })
})
