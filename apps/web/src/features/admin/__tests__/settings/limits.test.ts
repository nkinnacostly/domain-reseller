import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  boundsWords,
  changeRows,
  checkLimits,
  LIMIT_FIELD,
  LIMIT_FIELDS,
  LIMIT_GROUPS,
  LIMIT_KEYS,
  type Limits,
  limitInputs,
  limitWords,
  nairaWords,
  parseLimit,
  refundDirection,
  toInput,
} from '@/features/admin/lib/settings-limits'

/**
 * The limits form (docs/ADMIN-SPEC.md §3.1.2 `admin_update_ops_settings`,
 * §5.2 B13): exactly the 11 keys the wrapper takes, each with the wrapper's
 * own bounds, read as decimal text — never through a float — and the two
 * rules that span fields. Every figure here is a non-default limit, so no
 * wording can pass by repeating a default.
 */

/** Non-default limits: nothing below matches a value the database ships with. */
const LIMITS: Limits = {
  auto_refund_max_kobo: 31_250_050,
  auto_refund_daily_max_kobo: 123_400_000,
  refund_delay_minutes: 17,
  stuck_order_minutes: 23,
  max_domains_per_account_day: 37,
  velocity_new_max: 4,
  velocity_trusted_max: 211,
  velocity_standard_after_days: 9,
  velocity_trusted_after_days: 41,
  velocity_trusted_after_paid_orders: 6,
  float_alert_cents: 4_321,
}

const MIGRATION = readFileSync(
  join(__dirname, '../../../../../../../supabase/migrations/00000000000040_admin.sql'),
  'utf8',
)

describe('the 11 limits', () => {
  it('are exactly the keys admin_update_ops_settings accepts, grouped Refunds · Orders · Velocity · Float', () => {
    expect(LIMIT_FIELDS.map((field) => field.key)).toEqual([...LIMIT_KEYS])
    expect(LIMIT_KEYS).toHaveLength(11)
    const body = MIGRATION.slice(
      MIGRATION.indexOf('create function public.admin_update_ops_settings'),
    )
    const accepted = /if v_key not in \(([^)]*)\)/.exec(body)?.[1] ?? ''
    const sqlKeys = [...accepted.matchAll(/'([a-z_]+)'/g)].map((match) => match[1])
    expect([...sqlKeys].sort()).toEqual([...LIMIT_KEYS].sort())
    expect(LIMIT_GROUPS.map((group) => group.title)).toEqual([
      'Refunds',
      'Orders',
      'Velocity',
      'Float',
    ])
    for (const field of LIMIT_FIELDS) {
      expect(LIMIT_GROUPS.map((group) => group.id)).toContain(field.group)
    }
  })

  it("carry the wrapper's own bounds, key by key", () => {
    const body = MIGRATION.slice(
      MIGRATION.indexOf('create function public.admin_update_ops_settings'),
    )
    for (const field of LIMIT_FIELDS) {
      const bound = new RegExp(
        `v_key = '${field.key}' and v_num not between (\\d+) and (\\d+)`,
      ).exec(body)
      expect(bound, field.key).not.toBeNull()
      expect([field.min, field.max], field.key).toEqual([Number(bound?.[1]), Number(bound?.[2])])
    }
  })

  it('say their bounds beside each input', () => {
    expect(boundsWords(LIMIT_FIELD.auto_refund_max_kobo)).toBe('Up to ₦1,000,000.')
    expect(boundsWords(LIMIT_FIELD.auto_refund_daily_max_kobo)).toBe('Up to ₦5,000,000.')
    expect(boundsWords(LIMIT_FIELD.refund_delay_minutes)).toBe('5 to 1,440 minutes.')
    expect(boundsWords(LIMIT_FIELD.max_domains_per_account_day)).toBe('1 to 1,000 domains.')
    expect(boundsWords(LIMIT_FIELD.velocity_trusted_after_days)).toBe('0 to 3,650 days.')
    expect(boundsWords(LIMIT_FIELD.velocity_trusted_after_paid_orders)).toBe(
      '0 to 1,000 paid orders.',
    )
    expect(boundsWords(LIMIT_FIELD.float_alert_cents)).toBe('Up to $10,000.00.')
  })
})

describe('reading a typed limit', () => {
  const single = LIMIT_FIELD.auto_refund_max_kobo
  const floatAlert = LIMIT_FIELD.float_alert_cents
  const delay = LIMIT_FIELD.refund_delay_minutes
  const age = LIMIT_FIELD.velocity_standard_after_days

  it('reads naira and dollars as decimal text, so 0.29 is 29, never 28.99…', () => {
    expect(parseLimit(single, '0.29')).toEqual({ ok: true, value: 29 })
    expect(parseLimit(single, '312,500.5')).toEqual({ ok: true, value: 31_250_050 })
    expect(parseLimit(single, ' ₦250000 ')).toEqual({ ok: true, value: 25_000_000 })
    expect(parseLimit(floatAlert, '$43.21')).toEqual({ ok: true, value: 4_321 })
    expect(parseLimit(floatAlert, '0')).toEqual({ ok: true, value: 0 })
  })

  it('refuses a third decimal, a sign, words or nothing, saying what to type', () => {
    for (const text of ['1.005', '-5', 'ten', '', '1e5']) {
      expect(parseLimit(single, text)).toEqual({
        ok: false,
        error: 'Enter an amount in naira, such as 250000 or 250000.50.',
      })
    }
    expect(parseLimit(floatAlert, '12.345')).toEqual({
      ok: false,
      error: 'Enter an amount in dollars, such as 25 or 25.50.',
    })
    expect(parseLimit(delay, '10.5')).toEqual({ ok: false, error: 'Enter a whole number.' })
  })

  it('refuses a value outside the bounds, with the bounds in the words', () => {
    expect(parseLimit(single, '1000000.01')).toEqual({
      ok: false,
      error: 'Enter more than ₦0, up to ₦1,000,000.',
    })
    expect(parseLimit(single, '0')).toEqual({
      ok: false,
      error: 'Enter more than ₦0, up to ₦1,000,000.',
    })
    expect(parseLimit(floatAlert, '10000.01')).toEqual({
      ok: false,
      error: 'Enter up to $10,000.00.',
    })
    expect(parseLimit(delay, '4')).toEqual({ ok: false, error: 'Enter 5 to 1,440 minutes.' })
    expect(parseLimit(delay, '1441')).toEqual({ ok: false, error: 'Enter 5 to 1,440 minutes.' })
    expect(parseLimit(age, '0')).toEqual({ ok: true, value: 0 })
  })

  it('writes a stored value back as the input holds it', () => {
    expect(toInput(single, 31_250_050)).toBe('312500.50')
    expect(toInput(single, 25_000_000)).toBe('250000')
    expect(toInput(floatAlert, 4_321)).toBe('43.21')
    expect(toInput(floatAlert, 5)).toBe('0.05')
    expect(toInput(delay, 17)).toBe('17')
    for (const field of LIMIT_FIELDS) {
      expect(parseLimit(field, toInput(field, LIMITS[field.key])), field.key).toEqual({
        ok: true,
        value: LIMITS[field.key],
      })
    }
  })

  it('says each limit as people read it', () => {
    expect(nairaWords(31_250_050)).toBe('₦312,500.50')
    expect(nairaWords(123_400_000)).toBe('₦1,234,000')
    expect(limitWords(floatAlert, 4_321)).toBe('$43.21')
    expect(limitWords(delay, 1)).toBe('1 minute')
    expect(limitWords(delay, 17)).toBe('17 minutes')
    expect(limitWords(LIMIT_FIELD.velocity_new_max, 1)).toBe('1 domain')
    expect(limitWords(age, 1)).toBe('1 day')
    expect(limitWords(LIMIT_FIELD.velocity_trusted_after_paid_orders, 6)).toBe('6 paid orders')
    expect(limitWords(LIMIT_FIELD.velocity_trusted_after_paid_orders, 1)).toBe('1 paid order')
  })
})

describe('the whole form against the stored row', () => {
  it('has no changes and no errors as it opens', () => {
    expect(checkLimits(limitInputs(LIMITS), LIMITS)).toEqual({ errors: {}, changes: {} })
  })

  it('collects only the values that differ, in the stored unit', () => {
    const typed = { ...limitInputs(LIMITS), refund_delay_minutes: '12', float_alert_cents: '50' }
    expect(checkLimits(typed, LIMITS)).toEqual({
      errors: {},
      changes: { refund_delay_minutes: 12, float_alert_cents: 5_000 },
    })
  })

  it('keeps the daily refund limit at least the single one, judged on what would be stored', () => {
    const typed = { ...limitInputs(LIMITS), auto_refund_daily_max_kobo: '312500' }
    expect(checkLimits(typed, LIMITS).errors).toEqual({
      auto_refund_daily_max_kobo: 'Make it at least the single limit, ₦312,500.50.',
    })
    const raised = { ...limitInputs(LIMITS), auto_refund_max_kobo: '2000000' }
    expect(checkLimits(raised, LIMITS).errors.auto_refund_max_kobo).toBe(
      'Enter more than ₦0, up to ₦1,000,000.',
    )
    const both = {
      ...limitInputs(LIMITS),
      auto_refund_max_kobo: '900000',
      auto_refund_daily_max_kobo: '800000',
    }
    expect(checkLimits(both, LIMITS).errors).toEqual({
      auto_refund_daily_max_kobo: 'Make it at least the single limit, ₦900,000.',
    })
  })

  it('keeps the trusted cap at least the new-account cap', () => {
    const typed = { ...limitInputs(LIMITS), velocity_new_max: '300' }
    expect(checkLimits(typed, LIMITS).errors).toEqual({
      velocity_trusted_max: 'Make it at least the new-account limit, 300 domains.',
    })
  })

  it('lists each change before → after, in the form’s order', () => {
    expect(
      changeRows(LIMITS, { float_alert_cents: 5_000, auto_refund_max_kobo: 20_000_000 }),
    ).toEqual([
      {
        key: 'auto_refund_max_kobo',
        label: 'Largest refund sent without a person',
        before: '₦312,500.50',
        after: '₦200,000',
      },
      {
        key: 'float_alert_cents',
        label: 'Alert when the supplier balance is below',
        before: '$43.21',
        after: '$50.00',
      },
    ])
  })

  it('knows when a change lets more money go back without a person, and when less', () => {
    expect(refundDirection(LIMITS, { auto_refund_max_kobo: 31_250_051 })).toEqual({
      raises: true,
      lowers: false,
    })
    expect(refundDirection(LIMITS, { auto_refund_daily_max_kobo: 200_000_000 }).raises).toBe(true)
    expect(refundDirection(LIMITS, { refund_delay_minutes: 16 })).toEqual({
      raises: true,
      lowers: false,
    })
    expect(refundDirection(LIMITS, { refund_delay_minutes: 30 })).toEqual({
      raises: false,
      lowers: false,
    })
    expect(refundDirection(LIMITS, { auto_refund_max_kobo: 1_000_000 })).toEqual({
      raises: false,
      lowers: true,
    })
    expect(refundDirection(LIMITS, { auto_refund_daily_max_kobo: 50_000_000 }).lowers).toBe(true)
    expect(refundDirection(LIMITS, { velocity_new_max: 2 })).toEqual({
      raises: false,
      lowers: false,
    })
  })
})
