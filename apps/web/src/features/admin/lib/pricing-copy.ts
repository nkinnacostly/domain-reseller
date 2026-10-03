import { formatNaira, KOBO_PER_NAIRA, renewalSuffix } from '@dr/shared/pricing'
import type { Tone } from '@/features/admin/lib/tone'
import { formatUsd, formatWat } from './format'
import type { PricingSettings, RateRow } from './pricing-data'
import {
  type PriceEffect,
  type PricingChanges,
  type PricingKey,
  RATE_MAX_AGE_HOURS,
  type RateBlock,
  type Terms,
} from './pricing-rules'

/**
 * Every word the Pricing & FX pages say (docs/ADMIN-SPEC.md §5.2 B12). Each
 * describes what the code does and nothing more (N9b): the margin and the
 * ICANN fee reprice the site at once; the FX buffer is stamped on rates the
 * FX job fetches later; a rate is charged with its own buffer. Figures come
 * from the database — none is written here (N5b).
 */

const RATE = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const PERCENT = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 })

/** "₦1,330.57": naira to the dollar. A rate, not an amount of money. */
export function formatRate(rate: number | null | undefined): string {
  return rate === null || rate === undefined || !Number.isFinite(rate)
    ? '—'
    : `₦${RATE.format(rate)}`
}

/** "4%", "4.25%", "7.5%". */
export function formatPercent(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '—'
    : `${PERCENT.format(value)}%`
}

/** "+20.6%", "−4.4%": a move, signed, to one decimal place. */
export function formatMove(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return '—'
  const tenths = Math.round(pct * 10) / 10
  if (tenths === 0) return '0.0%'
  return `${tenths > 0 ? '+' : '−'}${Math.abs(tenths).toFixed(1)}%`
}

/** The margin, in naira from the settings, as kobo at the display edge (N5). */
export function formatMargin(marginNgn: number): string {
  return formatNaira(Math.round(marginNgn * KOBO_PER_NAIRA))
}

/** "$0.20" from whole cents. */
export function formatIcannFee(cents: number): string {
  return formatUsd(cents)
}

/** A stored setting, as the page shows it. */
export function settingValue(key: PricingKey, settings: PricingSettings): string {
  switch (key) {
    case 'margin_ngn':
      return formatMargin(settings.marginNgn)
    case 'fx_buffer_pct':
      return formatPercent(settings.fxBufferPct)
    case 'icann_fee_cents':
      return formatIcannFee(settings.icannFeeCents)
    case 'fx_move_threshold_pct':
      return formatPercent(settings.fxMoveThresholdPct)
  }
}

/** A value from the form, as the save dialog shows it. */
export function changeValue(key: PricingKey, value: number): string {
  switch (key) {
    case 'margin_ngn':
      return formatMargin(value)
    case 'icann_fee_cents':
      return formatIcannFee(value)
    default:
      return formatPercent(value)
  }
}

// ── The pages ───────────────────────────────────────────────────────────────

export const PRICING_TABS = [
  { href: '/admin/pricing', label: 'Pricing', exact: true },
  { href: '/admin/pricing/fx', label: 'Exchange rates' },
] as const

export const PRICING_DESCRIPTION =
  "Every price on the site is built from these settings, the active exchange rate and DomainNameAPI's catalogue. They are the same on the Live and Test sides."

export const FX_DESCRIPTION =
  'The rate every price is built from, and the rates the FX job held for review. Rates are the same on the Live and Test sides.'

export const VAT_READ_ONLY = "VAT is a statutory rate; it's changed in the SQL editor."

export const NO_SETTINGS = {
  title: 'No pricing settings',
  body: "The site shows no prices until there are pricing settings. They can't be created from here.",
}

export const STATUS_ERROR = {
  title: "Pricing couldn't be loaded.",
  body: 'Nothing was changed. Try again; prices on the site are not affected.',
}

export const OWNER_ONLY_SETTINGS = 'Only the owner can save these settings.'

export const CHANGED_NOTE = 'Who changed what, and why, is in the audit log.'
export const OWNER_ONLY_RATES = 'Only the owner can activate or reject a rate.'

/** What each stored setting does, under its value. */
export function settingNote(key: PricingKey | 'vat_pct', activeBufferPct: number | null): string {
  switch (key) {
    case 'margin_ngn':
      return 'Added to every domain and SSL certificate price, before rounding up to the next ₦100.'
    case 'fx_buffer_pct':
      return activeBufferPct === null
        ? 'Added to each rate the FX job fetches.'
        : `Added to each rate the FX job fetches. The active rate carries its own: ${formatPercent(activeBufferPct)}.`
    case 'icann_fee_cents':
      return 'A year, on generic extensions only — not on country codes such as .ng, nor on SSL certificates.'
    case 'fx_move_threshold_pct':
      return 'A fetched rate that moves further than this from the active one is held for review.'
    case 'vat_pct':
      return VAT_READ_ONLY
  }
}

/** Under each field of the form: the bounds `admin_update_pricing_settings` holds it to. */
export const FIELD_HINT: Record<PricingKey, string> = {
  margin_ngn: '₦1,000 to ₦50,000 a domain, in whole naira.',
  fx_buffer_pct: '0% to 20%, at most two decimal places. Added to rates fetched after you save.',
  icann_fee_cents: '0 to 200 US cents a year: 20 is $0.20.',
  fx_move_threshold_pct: '1% to 50%, at most two decimal places.',
}

export const FIELD_UNIT: Record<PricingKey, string> = {
  margin_ngn: '₦',
  fx_buffer_pct: '%',
  icann_fee_cents: 'US cents',
  fx_move_threshold_pct: '%',
}

/** The rate a price is built at, in words: the costing rate, and its buffer when it has one. */
export function chargedWords(costingRate: number, bufferPct: number, charged: number): string {
  return bufferPct > 0
    ? `${formatRate(charged)}: ${formatRate(costingRate)} plus its ${formatPercent(bufferPct)} buffer`
    : `${formatRate(charged)} (no buffer)`
}

/** "first year" / "first 2 years". */
function firstTermWords(years: number): string {
  return years === 1 ? 'first year' : `first ${years} years`
}

/** ".com today: ₦18,400 for the first year, then ₦18,600/yr." — always with its renewal (N8). */
export function exampleLine(tld: string, terms: Terms): string {
  return `.${tld} today: ${formatNaira(terms.first.priceKobo)} for the ${firstTermWords(terms.first.years)}, then ${formatNaira(terms.renewal.priceKobo)}${renewalSuffix(terms.renewal.years)}.`
}

/** Why there is no example price, when there is none. */
export function noExampleWords(
  tld: string,
  reason: 'not_on_sale' | 'no_price' | 'unreadable',
): string {
  switch (reason) {
    case 'not_on_sale':
      return `.${tld} isn't on sale, so there is no example price.`
    case 'no_price':
      return `No example price for .${tld}: the site shows none until there is an active rate.`
    case 'unreadable':
      return `No example price: .${tld}'s catalogue row couldn't be read.`
  }
}

/**
 * ".com: ₦18,400 → ₦23,400 first year; renews at ₦18,600 → ₦23,800/yr" — a
 * change's effect on one extension, first term and renewal (N8), each
 * priced by the shared functions. With a price on one side only, that side
 * is shown and the other is said in words.
 */
export function effectLine(effect: PriceEffect): string {
  const { before, after } = effect
  const terms = (t: Terms) =>
    `${formatNaira(t.first.priceKobo)} ${firstTermWords(t.first.years)}; renews at ${formatNaira(t.renewal.priceKobo)}${renewalSuffix(t.renewal.years)}`
  if (before && after) {
    return `.${effect.tld}: ${formatNaira(before.first.priceKobo)} → ${formatNaira(after.first.priceKobo)} ${firstTermWords(after.first.years)}; renews at ${formatNaira(before.renewal.priceKobo)} → ${formatNaira(after.renewal.priceKobo)}${renewalSuffix(after.renewal.years)}`
  }
  if (after) return `.${effect.tld}: ${terms(after)} (no price today)`
  if (before) return `.${effect.tld}: no price after this (today ${terms(before)})`
  return `.${effect.tld}: no price either way`
}

/** "How a price is built", with today's figures. */
export function buildSteps({
  settings,
  active,
}: {
  settings: PricingSettings
  active: { costingRate: number; bufferPct: number; charged: number } | null
}): string[] {
  return [
    "A year's cost from DomainNameAPI's catalogue, which the gateway syncs every week,",
    `plus the ICANN fee — ${formatIcannFee(settings.icannFeeCents)} a year — on generic extensions,`,
    active
      ? active.bufferPct > 0
        ? `at the active rate plus its ${formatPercent(active.bufferPct)} buffer, ${formatRate(active.charged)} to the dollar,`
        : `at the active rate, ${formatRate(active.charged)} to the dollar,`
      : 'at the active exchange rate — there is none, so the site shows no prices —',
    `plus the margin, ${formatMargin(settings.marginNgn)},`,
    'rounded up to the next ₦100: one year’s price.',
    `A longer registration is the first term at that price and each later year at the renewal price. SSL certificates are priced the same way, without the ICANN fee. VAT (${formatPercent(settings.vatPct)}) is added at checkout, never in list prices.`,
  ]
}

// ── The settings dialog ─────────────────────────────────────────────────────

const LABEL: Record<PricingKey, string> = {
  margin_ngn: 'Margin',
  fx_buffer_pct: 'FX buffer',
  icann_fee_cents: 'ICANN fee',
  fx_move_threshold_pct: 'Move threshold',
}

export type DialogRow = { label: string; value: string }

/** Save pricing settings (money, owner, `pricing.update`). */
export function saveCopy({
  changes,
  current,
  effect,
  activeBufferPct,
}: {
  changes: PricingChanges
  current: PricingSettings
  effect: PriceEffect | null
  activeBufferPct: number | null
}): {
  title: string
  rows: DialogRow[]
  body: string[]
  confirmLabel: string
  cancelLabel: string
  success: string
} {
  const keys = (Object.keys(LABEL) as PricingKey[]).filter((key) => changes[key] !== undefined)
  const reprices = changes.margin_ngn !== undefined || changes.icann_fee_cents !== undefined
  const rows: DialogRow[] = keys.map((key) => ({
    label: LABEL[key],
    value: `${settingValue(key, current)} → ${changeValue(key, changes[key] as number)}`,
  }))
  if (reprices && effect) rows.push({ label: 'Effect', value: effectLine(effect) })

  const body: string[] = []
  if (reprices) {
    body.push(
      'Prices on the site change on the next refresh, within minutes. Orders already placed keep their prices.',
    )
  }
  if (changes.fx_buffer_pct !== undefined) {
    body.push(
      activeBufferPct === null
        ? 'The buffer is added to rates the FX job fetches from now on.'
        : `The buffer is added to rates the FX job fetches from now on. The active rate keeps its own (${formatPercent(activeBufferPct)}), so it doesn't change today's prices.`,
    )
  }
  if (changes.fx_move_threshold_pct !== undefined) {
    body.push(
      'The FX job uses the new threshold from its next run: a fetched rate that moves further than this from the active one is held for review.',
    )
  }

  return {
    title: `Change ${keys.length} pricing ${keys.length === 1 ? 'setting' : 'settings'}?`,
    rows,
    body,
    confirmLabel: 'Save settings',
    cancelLabel: 'Cancel',
    success: reprices ? 'Saved. Prices on the site update on the next refresh.' : 'Saved.',
  }
}

// ── Exchange rates ──────────────────────────────────────────────────────────

export const FX_STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  pending_review: 'Held for review',
  superseded: 'Replaced',
  rejected: 'Rejected',
}

export const FX_STATUS_TONE: Record<string, Tone> = {
  active: 'ok',
  pending_review: 'warning',
  superseded: 'neutral',
  rejected: 'neutral',
}

/** The spec's words, and the wrapper's (RATE_TOO_OLD). */
export const TOO_OLD = 'Too old to activate — the daily job will fetch a fresh one.'

export const BLOCK_DETAIL: Record<RateBlock, string> = {
  too_old: `Quoted ${RATE_MAX_AGE_HOURS} hours ago or more.`,
  older_than_active: 'Quoted before the active rate.',
}

export const NO_ACTIVE_RATE = 'No active rate. The site shows no prices until one is activated.'

/** How rates reach this page: what scripts/update-fx-rate.ts does, run daily by pricing.yml. */
export function arrivalWords(toleranceInPct: number, thresholdPct: number | null): string {
  const threshold = thresholdPct === null ? 'the move threshold' : formatPercent(thresholdPct)
  return `The FX job runs once a day. It cross-checks the market feeds it can reach and stops if they disagree by more than ${formatPercent(toleranceInPct)}. A rate within ${threshold} of the active one is activated by the job; one that moves further, or arrives with no active rate, is held here for review.`
}

export function noneHeldWords(thresholdPct: number | null): string {
  const threshold = thresholdPct === null ? 'the move threshold' : formatPercent(thresholdPct)
  return `No rate is held for review. The FX job holds one here when it moves more than ${threshold} from the active rate, or when there is no active rate.`
}

/** A held rate's heading: "₦1,700.00 to the dollar". */
export function rateHeading(costingRate: number): string {
  return `${formatRate(costingRate)} to the dollar`
}

type Rate = Pick<RateRow, 'costingRate' | 'bufferPct' | 'source' | 'quotedAt'> & {
  charged: number
}
type Active = Rate & { effectiveFrom: string | null }

/** Activate (money, owner, `fx.activate`). */
export function activateCopy({
  rate,
  active,
  move,
  effect,
}: {
  rate: Rate
  active: Active | null
  move: number | null
  effect: PriceEffect | null
}): {
  title: string
  rows: DialogRow[]
  body: string
  confirmLabel: string
  cancelLabel: string
  success: string
} {
  const rows: DialogRow[] = [
    {
      label: 'Current',
      value: active
        ? `${formatRate(active.costingRate)} (quoted ${formatWat(active.quotedAt)}, since ${formatWat(active.effectiveFrom)})`
        : 'None — the site shows no prices',
    },
    {
      label: 'New',
      value: `${formatRate(rate.costingRate)} (${rate.source}, quoted ${formatWat(rate.quotedAt)})`,
    },
  ]
  if (rate.bufferPct > 0 || (active && active.bufferPct > 0)) {
    rows.push({
      label: 'Buffer',
      value: `${active ? formatPercent(active.bufferPct) : '—'} → ${formatPercent(rate.bufferPct)}`,
    })
  }
  rows.push({ label: 'Move', value: formatMove(move) })
  if (effect) rows.push({ label: 'Effect', value: effectLine(effect) })
  return {
    title: `Charge at ${formatRate(rate.charged)} to the dollar?`,
    rows,
    body: 'Every price on the site changes on the next refresh, within minutes. Orders already placed keep their rate.',
    confirmLabel: 'Activate rate',
    cancelLabel: 'Not now',
    success: 'Activated. Prices on the site update on the next refresh.',
  }
}

/** Reject (money, owner, `fx.reject`). */
export function rejectCopy({
  rate,
  reviewReason,
  active,
}: {
  rate: Pick<Rate, 'costingRate' | 'source' | 'quotedAt'>
  reviewReason: string | null
  active: { charged: number } | null
}): {
  title: string
  rows: DialogRow[]
  body: string
  confirmLabel: string
  cancelLabel: string
  success: string
} {
  return {
    title: `Reject the ${formatRate(rate.costingRate)} rate?`,
    rows: [
      {
        label: 'Rate',
        value: `${formatRate(rate.costingRate)} (${rate.source}, quoted ${formatWat(rate.quotedAt)})`,
      },
      { label: 'Held because', value: reviewReason ?? '—' },
    ],
    body: `${
      active
        ? `Prices stay on the active rate, ${formatRate(active.charged)}.`
        : 'The site keeps showing no prices until a rate is activated.'
    } The rejected rate stays in the history, marked rejected, and can't be activated from the dashboard.`,
    confirmLabel: 'Reject rate',
    cancelLabel: 'Keep it held',
    success: 'Rejected. Prices are unchanged.',
  }
}

/** Catalogue counts, in words that say exactly what `admin_pricing_status` counted. */
export function catalogueHints(status: {
  tlds: { total: number; sellable: number; paused: number; featured: number }
  ssl: { total: number; sellable: number; priced: number }
}): { tlds: string; ssl: string } {
  const n = (value: number) => value.toLocaleString('en-GB')
  return {
    tlds: `${n(status.tlds.sellable)} sellable, ${n(status.tlds.paused)} paused by us, ${n(status.tlds.featured)} featured`,
    ssl: `${n(status.ssl.sellable)} on sale, ${n(status.ssl.priced)} with a price from DomainNameAPI`,
  }
}
