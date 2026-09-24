import { describe, expect, it } from 'vitest'
import {
  type Allowance,
  accountAge,
  allowanceRefusal,
  exceedsAllowance,
  nextTier,
  parseAllowance,
} from '../lib/allowance'

/** What account_domain_allowance() answers with the default ops settings (migration 32). */
const allowance = (over: Partial<Allowance> = {}): Allowance => ({
  ordered: 0,
  max: 5,
  tier: 'new',
  paid_orders: 0,
  account_days: 2,
  standard_after_days: 7,
  trusted_after_days: 30,
  trusted_after_paid_orders: 3,
  ...over,
})

const refuse = (value: Allowance, adding: number, kind: 'order' | 'transfer' = 'order') =>
  allowanceRefusal(value, {
    adding,
    kind,
    email: 'hello@example.com',
    notCharged: "You haven't been charged.",
  })

describe('parseAllowance — fails closed on anything unexpected', () => {
  it('reads the database function’s answer', () => {
    expect(parseAllowance(allowance())).toEqual(allowance())
  })

  it.each([
    ['nothing', null],
    ['the old answer, without a tier', { ordered: 0, max: 20 }],
    ['a count sent as text', { ...allowance(), ordered: '3' }],
    ['a tier we do not know', { ...allowance(), tier: 'gold' }],
    ['a cap of zero', { ...allowance(), max: 0 }],
    ['a negative count', { ...allowance(), ordered: -1 }],
  ])('refuses %s', (_, data) => {
    expect(parseAllowance(data)).toBeNull()
  })
})

describe('exceedsAllowance', () => {
  it('lets an order land exactly on the cap', () => {
    expect(exceedsAllowance(allowance({ ordered: 3 }), 2)).toBe(false)
  })

  it('stops one domain past it', () => {
    expect(exceedsAllowance(allowance({ ordered: 3 }), 3)).toBe(true)
  })

  it('stops any order once the cap is used up', () => {
    expect(exceedsAllowance(allowance({ ordered: 5 }), 1)).toBe(true)
  })
})

describe('accountAge', () => {
  it.each([
    [1, 'a day'],
    [3, '3 days'],
    [7, 'a week'],
    [14, 'two weeks'],
    [21, 'three weeks'],
    [28, 'four weeks'],
    [30, '30 days'],
    [35, '35 days'],
  ])('%i days reads as “%s”', (days, words) => {
    expect(accountAge(days)).toBe(words)
  })
})

describe('nextTier — what raises the cap, from the account’s own numbers', () => {
  it('a new account moves up with its first paid order or its age', () => {
    expect(nextTier(allowance())).toBe(
      'That rises after your first paid order, or once your account is a week old.',
    )
  })

  it('follows the configured age, never a fixed week', () => {
    expect(nextTier(allowance({ standard_after_days: 10 }))).toBe(
      'That rises after your first paid order, or once your account is 10 days old.',
    )
  })

  it('names only the paid order when age does not count', () => {
    expect(nextTier(allowance({ standard_after_days: 0 }))).toBe(
      'That rises after your first paid order.',
    )
  })

  it('a standard account needs age and paid orders — both named while both are missing', () => {
    const standard = allowance({ tier: 'standard', max: 20, account_days: 8, paid_orders: 1 })
    expect(nextTier(standard)).toBe(
      'That rises once your account is 30 days old and has 3 paid orders.',
    )
  })

  it('names only the age once the paid orders are there', () => {
    const standard = allowance({ tier: 'standard', max: 20, account_days: 8, paid_orders: 4 })
    expect(nextTier(standard)).toBe('That rises once your account is 30 days old.')
  })

  it('counts down the paid orders once the account is old enough', () => {
    const standard = allowance({ tier: 'standard', max: 20, account_days: 45, paid_orders: 1 })
    expect(nextTier(standard)).toBe('That rises after 2 more paid orders.')
    expect(nextTier({ ...standard, paid_orders: 2 })).toBe('That rises after 1 more paid order.')
  })

  it('says “1 paid order” in the singular', () => {
    const standard = allowance({
      tier: 'standard',
      max: 20,
      account_days: 8,
      trusted_after_paid_orders: 1,
    })
    expect(nextTier(standard)).toBe(
      'That rises once your account is 30 days old and has 1 paid order.',
    )
  })

  it('names only the age when paid orders are not part of the rule', () => {
    const standard = allowance({
      tier: 'standard',
      max: 20,
      account_days: 8,
      trusted_after_paid_orders: 0,
    })
    expect(nextTier(standard)).toBe('That rises once your account is 30 days old.')
  })

  it('promises nothing on the top tier', () => {
    expect(nextTier(allowance({ tier: 'trusted', max: 100 }))).toBeNull()
  })

  it('promises nothing when a standard account already meets both conditions', () => {
    const standard = allowance({ tier: 'standard', max: 20, account_days: 31, paid_orders: 3 })
    expect(nextTier(standard)).toBeNull()
  })
})

describe('allowanceRefusal', () => {
  it('tells a new account its cap, how it rises, and what to remove', () => {
    expect(refuse(allowance(), 7)).toBe(
      "New accounts can order up to 5 domains a day, and this would take you to 7. That rises after your first paid order, or once your account is a week old. You haven't been charged. Remove 2 domains from your cart, or email hello@example.com to raise your limit.",
    )
  })

  it('says one domain in the singular', () => {
    expect(refuse(allowance({ ordered: 2 }), 4)).toContain('Remove 1 domain from your cart')
  })

  it('asks for patience once the day’s cap is used up — a smaller cart would not help', () => {
    const message = refuse(allowance({ ordered: 5 }), 1)
    expect(message).toMatch(/^New accounts can order up to 5 domains a day, and you have ordered 5/)
    expect(message).toContain('Each order stops counting 24 hours after it was placed')
    expect(message).not.toContain('Remove')
  })

  it('speaks of the account, not new accounts, on a higher tier', () => {
    const standard = allowance({ tier: 'standard', max: 20, account_days: 8, paid_orders: 1 })
    expect(refuse(standard, 21)).toBe(
      "Your account can order up to 20 domains a day, and this would take you to 21. That rises once your account is 30 days old and has 3 paid orders. You haven't been charged. Remove 1 domain from your cart, or email hello@example.com to raise your limit.",
    )
  })

  it('offers only the email on the top tier', () => {
    const trusted = allowance({ tier: 'trusted', max: 100, ordered: 100 })
    expect(refuse(trusted, 1)).toBe(
      "Your account can order up to 100 domains a day, and you have ordered 100 in the last 24 hours. You haven't been charged. Each order stops counting 24 hours after it was placed, so try again later, or email hello@example.com to raise your limit.",
    )
  })

  it('says transfers in count, for a transfer', () => {
    expect(refuse(allowance({ ordered: 5 }), 1, 'transfer')).toMatch(
      /^New accounts can order up to 5 domains a day, transfers in included, and you have ordered 5 in the last 24 hours\./,
    )
  })

  it('reads a cap of one in the singular', () => {
    expect(refuse(allowance({ max: 1, ordered: 1 }), 1)).toMatch(/up to 1 domain a day/)
  })
})
