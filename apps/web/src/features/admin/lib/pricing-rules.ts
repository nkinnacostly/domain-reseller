import {
  effectiveFxRate,
  type PricingInputs,
  priceCatalogue,
  type TldRecord,
} from '@dr/shared/pricing'
import type { PricingSettings, SampleTld } from './pricing-data'

/**
 * The Pricing & FX pages' rules (docs/ADMIN-SPEC.md §3.1.2, §5.2 B12). Which
 * rates may be activated mirrors `admin_activate_fx_rate`, which decides
 * again; what a change does to a price is worked out by the storefront's own
 * functions in `@dr/shared` (`priceCatalogue`), never by maths written here.
 */

/** `admin_activate_fx_rate` refuses a rate quoted this long ago or more (RATE_TOO_OLD). */
export const RATE_MAX_AGE_HOURS = 48

const HOUR_MS = 3_600_000

export type RateBlock = 'too_old' | 'older_than_active'

/**
 * Whether a held rate may be activated, or only rejected. SQL's own flags
 * count, and so does the clock now: a rate quoted 48 hours ago or more, or
 * at or before the active rate's quote, offers Reject only — the wrapper
 * would refuse it as RATE_TOO_OLD or NEWER_RATE_ACTIVE.
 */
export function rateOffers(
  rate: { quotedAt: string; tooOld?: boolean; olderThanActive?: boolean },
  active: { quotedAt: string } | null,
  now: Date,
): { activate: boolean; reject: true; blockedBy: RateBlock | null } {
  const quoted = Date.parse(rate.quotedAt)
  const tooOld =
    Boolean(rate.tooOld) ||
    !Number.isFinite(quoted) ||
    quoted <= now.getTime() - RATE_MAX_AGE_HOURS * HOUR_MS
  const olderThanActive =
    Boolean(rate.olderThanActive) || (active !== null && !(quoted > Date.parse(active.quotedAt)))
  const blockedBy: RateBlock | null = tooOld
    ? 'too_old'
    : olderThanActive
      ? 'older_than_active'
      : null
  return { activate: blockedBy === null, reject: true, blockedBy }
}

/**
 * How far a rate is from another, in percent (costing rates, as the daily
 * job measures a move). Null without both.
 */
export function movePct(rate: number, from: number | null | undefined): number | null {
  if (from === null || from === undefined || !(from > 0) || !(rate > 0)) return null
  return (rate / from - 1) * 100
}

/** The rate a price is built at: the costing rate plus that rate's own buffer. */
export function chargedRate(rate: { costingRate: number; bufferPct: number }): number {
  return effectiveFxRate(rate.costingRate, rate.bufferPct)
}

/**
 * Everything a price needs, as the storefront assembles it (N5b): the rate
 * and its own buffer from `fx_rates`, the margin and ICANN fee from
 * `pricing_settings`. Null without a rate or settings: no price then.
 */
export function pricingInputs(
  rate: { costingRate: number; bufferPct: number } | null,
  settings: Pick<PricingSettings, 'marginNgn' | 'icannFeeCents'> | null,
): PricingInputs | null {
  if (!rate || !settings) return null
  return {
    fxRate: rate.costingRate,
    fxBufferPct: rate.bufferPct,
    marginNgn: settings.marginNgn,
    icannFeeUsd: settings.icannFeeCents / 100,
  }
}

/** The catalogue row as the shared pricing functions take it. */
export function sampleRecord(sample: SampleTld): TldRecord {
  return {
    name: sample.name,
    registerUsd: sample.registerCents / 100,
    renewUsd: sample.renewCents / 100,
    // Neither enters a first term or a renewal, which is all the example prices.
    transferUsd: null,
    restoreUsd: null,
    isCountryCode: sample.isCountryCode,
    minPeriod: sample.minPeriod,
    maxPeriod: sample.maxPeriod,
    registerPeriods: sample.registerPeriods,
    renewPeriods: sample.renewPeriods,
    redemptionDays: 0,
    requiresExtraFields: false,
  }
}

export type Term = { years: number; priceKobo: number }
export type Terms = { first: Term; renewal: Term }

/**
 * The extension's first term and renewal term (N8) at these inputs, priced by
 * `priceCatalogue` exactly as the storefront prices it. Null when it has no
 * price there.
 */
export function termsAt(sample: SampleTld, inputs: PricingInputs | null): Terms | null {
  if (!inputs) return null
  try {
    const [priced] = priceCatalogue([sampleRecord(sample)], inputs)
    return priced ? { first: priced.firstTerm, renewal: priced.renewalTerm } : null
  } catch {
    // A rate or buffer the shared functions refuse is no price, not a guess.
    return null
  }
}

/** One extension's prices before and after a change. */
export type PriceEffect = { tld: string; before: Terms | null; after: Terms | null }

/**
 * What a change does to the example's prices. Null when there is nothing to
 * say: no example, or no price on either side of the change.
 */
export function priceEffect(
  sample: SampleTld | null,
  before: PricingInputs | null,
  after: PricingInputs | null,
): PriceEffect | null {
  if (!sample) return null
  const effect = {
    tld: sample.name,
    before: termsAt(sample, before),
    after: termsAt(sample, after),
  }
  return effect.before || effect.after ? effect : null
}

// ── The settings form ───────────────────────────────────────────────────────

export type PricingKey =
  | 'margin_ngn'
  | 'fx_buffer_pct'
  | 'icann_fee_cents'
  | 'fx_move_threshold_pct'

export type PricingField = Readonly<{
  key: PricingKey
  /** Where `admin_pricing_status` puts the stored value. */
  from: keyof Omit<PricingSettings, 'vatPct'>
  label: string
  min: number
  max: number
  /** Decimal places allowed: whole numbers when 0. */
  decimals: number
}>

/**
 * The four keys `admin_update_pricing_settings` takes, with the bounds it
 * holds them to (OUT_OF_RANGE). VAT is not one: it is statutory, and changed
 * in the SQL editor only.
 */
export const PRICING_FIELDS: readonly PricingField[] = [
  { key: 'margin_ngn', from: 'marginNgn', label: 'Margin', min: 1000, max: 50_000, decimals: 0 },
  { key: 'fx_buffer_pct', from: 'fxBufferPct', label: 'FX buffer', min: 0, max: 20, decimals: 2 },
  {
    key: 'icann_fee_cents',
    from: 'icannFeeCents',
    label: 'ICANN fee',
    min: 0,
    max: 200,
    decimals: 0,
  },
  {
    key: 'fx_move_threshold_pct',
    from: 'fxMoveThresholdPct',
    label: 'Move threshold',
    min: 1,
    max: 50,
    decimals: 2,
  },
]

export type PricingChanges = Partial<Record<PricingKey, number>>

/** Whether a number has at most `decimals` places, judged on its shortest text. */
export function hasDecimals(value: number, decimals: number): boolean {
  if (!Number.isFinite(value)) return false
  const text = String(value)
  if (/e/i.test(text)) return false
  const fraction = text.split('.')[1] ?? ''
  return fraction.length <= decimals
}

/** A typed value for one field: the number, or the words for what is wrong. */
export function parseFieldValue(
  field: PricingField,
  typed: string,
): { value: number } | { error: string } {
  const text = typed.replace(/[\s,]/g, '')
  const shape = field.decimals === 0 ? /^\d+$/ : new RegExp(`^\\d+(\\.\\d{1,${field.decimals}})?$`)
  const value = Number(text)
  if (!text || !shape.test(text) || value < field.min || value > field.max) {
    return { error: fieldBoundsWords(field) }
  }
  return { value }
}

/** "Enter ₦1,000 to ₦50,000, in whole naira." — the bounds SQL holds the field to. */
export function fieldBoundsWords(field: PricingField): string {
  switch (field.key) {
    case 'margin_ngn':
      return `Enter ₦${field.min.toLocaleString('en-GB')} to ₦${field.max.toLocaleString('en-GB')}, in whole naira.`
    case 'icann_fee_cents':
      return `Enter ${field.min} to ${field.max} US cents, a whole number.`
    default:
      return `Enter ${field.min}% to ${field.max}%, with at most ${field.decimals} decimal places.`
  }
}

/**
 * What the form would save: each field whose typed value differs from the
 * stored one, or the words for each field that does not parse. Unchanged
 * fields are left out, so the wrapper records only what moved.
 */
export function pricingChanges(
  current: PricingSettings,
  typed: Partial<Record<PricingKey, string>>,
): { changes: PricingChanges; errors: Partial<Record<PricingKey, string>> } {
  const changes: PricingChanges = {}
  const errors: Partial<Record<PricingKey, string>> = {}
  for (const field of PRICING_FIELDS) {
    const text = typed[field.key]
    if (text === undefined) continue
    const parsed = parseFieldValue(field, text)
    if ('error' in parsed) errors[field.key] = parsed.error
    else if (parsed.value !== current[field.from]) changes[field.key] = parsed.value
  }
  return { changes, errors }
}

/** The settings after a change, for pricing the example at them. */
export function settingsAfter(current: PricingSettings, changes: PricingChanges): PricingSettings {
  return {
    ...current,
    ...(changes.margin_ngn !== undefined ? { marginNgn: changes.margin_ngn } : {}),
    ...(changes.fx_buffer_pct !== undefined ? { fxBufferPct: changes.fx_buffer_pct } : {}),
    ...(changes.icann_fee_cents !== undefined ? { icannFeeCents: changes.icann_fee_cents } : {}),
    ...(changes.fx_move_threshold_pct !== undefined
      ? { fxMoveThresholdPct: changes.fx_move_threshold_pct }
      : {}),
  }
}

/** Margin and the ICANN fee reprice the site at once; the buffer and the threshold do not. */
export function changesPrices(changes: PricingChanges): boolean {
  return changes.margin_ngn !== undefined || changes.icann_fee_cents !== undefined
}
