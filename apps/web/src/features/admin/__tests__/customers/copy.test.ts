import { describe, expect, it } from 'vitest'
import {
  allowanceRule,
  allowanceUsed,
  CUSTOMER_TEST_ADMIN,
  kindsText,
  LOOKUPS_PER_HOUR,
  NO_CUSTOMERS,
  REVEAL_BODY,
  REVEAL_TITLE,
  REVEAL_TRIGGER,
  SEARCH_COUNTS,
  SEARCH_FOUND,
  SEARCH_HINT,
  STATS_HIDDEN,
  sideWord,
  tierLabel,
} from '@/features/admin/lib/customers-copy'
import type { CustomerAllowance } from '@/features/admin/lib/customers-data'
import { ADMIN_ERROR_WORDS } from '@/features/admin/lib/errors'

/**
 * The customers pages' words, held exactly (ADMIN-SPEC §5.2 B8): the
 * reveal's title and body as the spec gives them, the test admin's "Not
 * shown", and the allowance rule from the account's own settings — never a
 * number written into the copy (N9b).
 */

const allowance = (overrides: Partial<CustomerAllowance> = {}): CustomerAllowance => ({
  ordered: 2,
  max: 10,
  tier: 'standard',
  paid_orders: 1,
  account_days: 32,
  standard_after_days: 7,
  trusted_after_days: 90,
  trusted_after_paid_orders: 3,
  ...overrides,
})

describe('the spec’s own words', () => {
  it('asks before showing contact details, and says the view is recorded', () => {
    expect(REVEAL_TRIGGER).toBe('Show contact details')
    expect(REVEAL_TITLE).toBe('Show this customer’s contact details?')
    expect(REVEAL_BODY).toBe('Your view is recorded in the audit log.')
  })

  it('tells a test admin what is not shown', () => {
    expect(STATS_HIDDEN).toBe('Not shown to test administrators.')
    expect(CUSTOMER_TEST_ADMIN).toBe('Not shown to test administrators.')
  })

  it('says the search is never in the address, and gives SQL’s hourly limit', () => {
    expect(SEARCH_HINT).toContain('never in the page address')
    expect(SEARCH_HINT).toContain(`${LOOKUPS_PER_HOUR} searches and contact views an hour`)
    expect(LOOKUPS_PER_HOUR).toBe(30)
    // The limit's refusal comes from the shared words.
    expect(ADMIN_ERROR_WORDS.RATE_LIMITED).toBe(
      "You've looked up a lot of customers this hour. Wait, or ask the owner.",
    )
    expect(ADMIN_ERROR_WORDS.BAD_QUERY).toBe(
      'Search by an exact email address, order number or domain.',
    )
  })

  it('counts and names sides in words', () => {
    expect(sideWord('live')).toBe('Live')
    expect(sideWord('test')).toBe('Test')
    expect(SEARCH_FOUND(1)).toBe('1 customer matches exactly')
    expect(SEARCH_FOUND(3)).toBe('3 customers match exactly')
    expect(SEARCH_COUNTS(true)).toBe('Domains and orders on the Test side.')
    expect(SEARCH_COUNTS(false)).toBe('Domains and orders on the Live side.')
    expect(NO_CUSTOMERS(true)).toBe('No e2e test accounts right now.')
    expect(NO_CUSTOMERS(false)).toBe('No customers yet.')
  })
})

describe('the daily allowance', () => {
  it('says how much of the day’s limit is used', () => {
    expect(allowanceUsed(allowance())).toBe('2 of 10 new domains in the last 24 hours')
  })

  it('names each tier, and shows an unknown one as itself', () => {
    expect(tierLabel('new')).toBe('New account')
    expect(tierLabel('standard')).toBe('Standard')
    expect(tierLabel('trusted')).toBe('Trusted')
    expect(tierLabel('very_trusted')).toBe('very trusted')
  })

  it('states the rule from the account’s settings, interpolated, never literal', () => {
    expect(allowanceRule(allowance(), 'live')).toBe(
      'Standard after 7 days or a first paid order; trusted after 90 days and 3 paid orders. This account: 32 days old, 1 paid order.',
    )
    expect(
      allowanceRule(
        allowance({
          standard_after_days: 1,
          trusted_after_days: 45,
          trusted_after_paid_orders: 1,
          account_days: 1,
          paid_orders: 0,
        }),
        'live',
      ),
    ).toBe(
      'Standard after 1 day or a first paid order; trusted after 45 days and 1 paid order. This account: 1 day old, 0 paid orders.',
    )
  })

  it('says test orders always get the trusted limit', () => {
    expect(allowanceRule(allowance(), 'test')).toBe('Test orders always get the trusted limit.')
  })
})

describe('kindsText', () => {
  it('names each kind once, in a fixed order', () => {
    expect(kindsText(['ssl', 'register', 'ssl'])).toBe('Registration, Certificate')
    expect(kindsText(['transfer', 'renew'])).toBe('Renewal, Transfer in')
    expect(kindsText(['gift_card', 'register'])).toBe('Registration, gift card')
    expect(kindsText([])).toBe('No lines')
  })
})
