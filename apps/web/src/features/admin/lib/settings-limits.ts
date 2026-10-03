import { formatUsdCents } from '@dr/shared/admin'

/**
 * The 11 limits in `ops_settings` the owner tunes from Settings
 * (docs/ADMIN-SPEC.md §3.1.2 `admin_update_ops_settings`, §5.2 B13). Each is
 * held here in the unit the wrapper takes — kobo, cents, minutes, days or a
 * count — with the wrapper's own bounds, so the form refuses what SQL would
 * refuse and says the bounds before anyone types. SQL checks them again.
 * No limit's number is written into copy: every figure shown comes from the
 * row (CLAUDE.md §15, "the daily cap … lives in `ops_settings`").
 */

export const LIMIT_KEYS = [
  'auto_refund_max_kobo',
  'auto_refund_daily_max_kobo',
  'refund_delay_minutes',
  'stuck_order_minutes',
  'max_domains_per_account_day',
  'velocity_new_max',
  'velocity_trusted_max',
  'velocity_standard_after_days',
  'velocity_trusted_after_days',
  'velocity_trusted_after_paid_orders',
  'float_alert_cents',
] as const

export type LimitKey = (typeof LIMIT_KEYS)[number]

export type Limits = Readonly<Record<LimitKey, number>>

export type LimitGroup = 'refunds' | 'orders' | 'velocity' | 'float'

/** How a limit is typed and read: naira, dollars, or a whole number of something. */
export type LimitUnit = 'kobo' | 'cents' | 'minutes' | 'days' | 'domains' | 'orders'

export type LimitField = Readonly<{
  key: LimitKey
  group: LimitGroup
  label: string
  /** What the number does, in a sentence. */
  help: string
  unit: LimitUnit
  /** The wrapper's bounds, in the stored unit. */
  min: number
  max: number
}>

export const LIMIT_GROUPS: readonly { id: LimitGroup; title: string }[] = [
  { id: 'refunds', title: 'Refunds' },
  { id: 'orders', title: 'Orders' },
  { id: 'velocity', title: 'Velocity' },
  { id: 'float', title: 'Float' },
]

export const LIMIT_FIELDS: readonly LimitField[] = [
  {
    key: 'auto_refund_max_kobo',
    group: 'refunds',
    label: 'Largest refund sent without a person',
    help: 'A bigger refund is held until someone approves it.',
    unit: 'kobo',
    min: 1,
    max: 100_000_000,
  },
  {
    key: 'auto_refund_daily_max_kobo',
    group: 'refunds',
    label: 'Refunds sent without a person, per day',
    help: 'Once this much has gone back in a day, the rest are held. At least the single limit.',
    unit: 'kobo',
    min: 1,
    max: 500_000_000,
  },
  {
    key: 'refund_delay_minutes',
    group: 'refunds',
    label: 'Wait before a refund is sent',
    help: 'Time to stop a refund that should not go.',
    unit: 'minutes',
    min: 5,
    max: 1440,
  },
  {
    key: 'stuck_order_minutes',
    group: 'orders',
    label: 'A paid order counts as stuck after',
    help: 'A paid order not finished by then raises an alert.',
    unit: 'minutes',
    min: 5,
    max: 1440,
  },
  {
    key: 'max_domains_per_account_day',
    group: 'orders',
    label: 'New domains a day, standard accounts',
    help: 'An account past its first days, or with a paid order. Renewals do not count.',
    unit: 'domains',
    min: 1,
    max: 1000,
  },
  {
    key: 'velocity_new_max',
    group: 'velocity',
    label: 'New domains a day, new accounts',
    help: 'An account with no paid order, in its first days.',
    unit: 'domains',
    min: 1,
    max: 1000,
  },
  {
    key: 'velocity_trusted_max',
    group: 'velocity',
    label: 'New domains a day, trusted accounts',
    help: 'At least the new-account limit.',
    unit: 'domains',
    min: 1,
    max: 5000,
  },
  {
    key: 'velocity_standard_after_days',
    group: 'velocity',
    label: 'An account is standard after',
    help: 'Or sooner, with a paid order.',
    unit: 'days',
    min: 0,
    max: 365,
  },
  {
    key: 'velocity_trusted_after_days',
    group: 'velocity',
    label: 'An account can be trusted after',
    help: 'It also needs the paid orders below.',
    unit: 'days',
    min: 0,
    max: 3650,
  },
  {
    key: 'velocity_trusted_after_paid_orders',
    group: 'velocity',
    label: 'Paid orders before an account is trusted',
    help: 'Counted with the age above.',
    unit: 'orders',
    min: 0,
    max: 1000,
  },
  {
    key: 'float_alert_cents',
    group: 'float',
    label: 'Alert when the supplier balance is below',
    help: "DomainNameAPI's prepaid balance, in US dollars.",
    unit: 'cents',
    min: 0,
    max: 1_000_000,
  },
]

export const LIMIT_FIELD: Readonly<Record<LimitKey, LimitField>> = Object.fromEntries(
  LIMIT_FIELDS.map((field) => [field.key, field]),
) as Record<LimitKey, LimitField>

const NAIRA = new Intl.NumberFormat('en-NG', {
  style: 'currency',
  currency: 'NGN',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})
const NAIRA_KOBO = new Intl.NumberFormat('en-NG', {
  style: 'currency',
  currency: 'NGN',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** ₦250,000 — or ₦250,000.50 when there are kobo: two limits a kobo apart never read the same. */
export function nairaWords(kobo: number): string {
  return kobo % 100 === 0 ? NAIRA.format(kobo / 100) : NAIRA_KOBO.format(kobo / 100)
}

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString('en-GB')} ${count === 1 ? one : many}`

/** A limit's value as people read it: ₦250,000 · $25.00 · 10 minutes · 20 domains. */
export function limitWords(field: LimitField, value: number): string {
  switch (field.unit) {
    case 'kobo':
      return nairaWords(value)
    case 'cents':
      return formatUsdCents(value)
    case 'minutes':
      return plural(value, 'minute', 'minutes')
    case 'days':
      return plural(value, 'day', 'days')
    case 'domains':
      return plural(value, 'domain', 'domains')
    case 'orders':
      return plural(value, 'paid order', 'paid orders')
  }
}

/** The bounds beside each input: "Up to ₦1,000,000." · "5 to 1,440 minutes." */
export function boundsWords(field: LimitField): string {
  if (field.unit === 'kobo' || field.unit === 'cents') {
    return `Up to ${limitWords(field, field.max)}.`
  }
  const unit = limitWords(field, field.max).replace(/^[\d,]+ /, '')
  return `${field.min.toLocaleString('en-GB')} to ${field.max.toLocaleString('en-GB')} ${unit}.`
}

/** What the input holds for a stored value: naira or dollars as decimals, the rest whole. */
export function toInput(field: LimitField, value: number): string {
  if (field.unit === 'kobo' || field.unit === 'cents') {
    const whole = Math.trunc(value / 100)
    const part = value % 100
    return part === 0 ? String(whole) : `${whole}.${String(part).padStart(2, '0')}`
  }
  return String(value)
}

const MONEY = /^(\d{1,9})(?:\.(\d{1,2}))?$/
const WHOLE = /^\d{1,7}$/

export type Parsed = { ok: true; value: number } | { ok: false; error: string }

/**
 * A typed value in the stored unit, read as decimal text — never through a
 * float, so ₦0.29 is 29 kobo (N5). Commas and a leading ₦ or $ are allowed;
 * anything else, or a value outside the bounds, is refused in words.
 */
export function parseLimit(field: LimitField, text: string): Parsed {
  const cleaned = text.trim().replace(/[,\s]/g, '').replace(/^[₦$]/, '')
  const money = field.unit === 'kobo' || field.unit === 'cents'
  let value: number
  if (money) {
    const match = MONEY.exec(cleaned)
    if (!match) {
      return {
        ok: false,
        error:
          field.unit === 'kobo'
            ? 'Enter an amount in naira, such as 250000 or 250000.50.'
            : 'Enter an amount in dollars, such as 25 or 25.50.',
      }
    }
    value = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  } else {
    if (!WHOLE.test(cleaned)) return { ok: false, error: 'Enter a whole number.' }
    value = Number(cleaned)
  }
  if (value < field.min || value > field.max) return { ok: false, error: rangeWords(field) }
  return { ok: true, value }
}

/** What to type instead of a value outside the bounds. */
function rangeWords(field: LimitField): string {
  if (field.unit === 'kobo' || field.unit === 'cents') {
    const top = limitWords(field, field.max)
    return field.min > 0
      ? `Enter more than ${limitWords(field, 0)}, up to ${top}.`
      : `Enter up to ${top}.`
  }
  return `Enter ${boundsWords(field)}`
}

export type LimitCheck = {
  /** One message per field that cannot be saved. */
  errors: Partial<Record<LimitKey, string>>
  /** The values that differ from what is stored, in the stored unit. */
  changes: Partial<Record<LimitKey, number>>
}

/**
 * The whole form against the stored row: each field's bounds, then the two
 * rules that span fields — the daily refund limit at least the single one,
 * the trusted cap at least the new-account cap — judged on the values that
 * would be stored, as the wrapper judges them.
 */
export function checkLimits(
  typed: Readonly<Record<LimitKey, string>>,
  current: Limits,
): LimitCheck {
  const errors: Partial<Record<LimitKey, string>> = {}
  const changes: Partial<Record<LimitKey, number>> = {}
  const next: Record<LimitKey, number> = { ...current }
  for (const field of LIMIT_FIELDS) {
    const parsed = parseLimit(field, typed[field.key] ?? '')
    if (!parsed.ok) {
      errors[field.key] = parsed.error
      continue
    }
    next[field.key] = parsed.value
    if (parsed.value !== current[field.key]) changes[field.key] = parsed.value
  }
  if (
    !errors.auto_refund_max_kobo &&
    !errors.auto_refund_daily_max_kobo &&
    next.auto_refund_daily_max_kobo < next.auto_refund_max_kobo
  ) {
    errors.auto_refund_daily_max_kobo = `Make it at least the single limit, ${nairaWords(next.auto_refund_max_kobo)}.`
  }
  if (
    !errors.velocity_new_max &&
    !errors.velocity_trusted_max &&
    next.velocity_trusted_max < next.velocity_new_max
  ) {
    errors.velocity_trusted_max = `Make it at least the new-account limit, ${limitWords(LIMIT_FIELD.velocity_new_max, next.velocity_new_max)}.`
  }
  return { errors, changes }
}

export type LimitChangeRow = { key: LimitKey; label: string; before: string; after: string }

/** Before → after for each changed limit, in the form's order. */
export function changeRows(
  current: Limits,
  changes: Partial<Record<LimitKey, number>>,
): LimitChangeRow[] {
  return LIMIT_FIELDS.filter((field) => changes[field.key] !== undefined).map((field) => ({
    key: field.key,
    label: field.label,
    before: limitWords(field, current[field.key]),
    after: limitWords(field, changes[field.key] as number),
  }))
}

/**
 * Which way a change moves refunds. A rise in either refund limit, or a
 * shorter wait, lets more money go back without a person: SQL records that
 * as `settings.refund_limit_raise` and it is alerted (§3.1.2).
 */
export function refundDirection(
  current: Limits,
  changes: Partial<Record<LimitKey, number>>,
): { raises: boolean; lowers: boolean } {
  const single = changes.auto_refund_max_kobo
  const daily = changes.auto_refund_daily_max_kobo
  const delay = changes.refund_delay_minutes
  const raises =
    (single !== undefined && single > current.auto_refund_max_kobo) ||
    (daily !== undefined && daily > current.auto_refund_daily_max_kobo) ||
    (delay !== undefined && delay < current.refund_delay_minutes)
  const lowers =
    (single !== undefined && single < current.auto_refund_max_kobo) ||
    (daily !== undefined && daily < current.auto_refund_daily_max_kobo)
  return { raises, lowers }
}

/** The form's starting text for every field, from the stored row. */
export function limitInputs(current: Limits): Record<LimitKey, string> {
  return Object.fromEntries(
    LIMIT_FIELDS.map((field) => [field.key, toInput(field, current[field.key])]),
  ) as Record<LimitKey, string>
}
