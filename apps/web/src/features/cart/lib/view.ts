import {
  formatNaira,
  formatRenewal,
  namesBase,
  periodTotalKobo,
  SSL_TERM,
  type TldPricing,
} from '@dr/shared'
import { periodsText, yearsText } from '@/features/pricing/lib/terms'
import type { LineStatus, PricedLine } from './lines'
import { type PricedSslLine, type SslLineKind, siteOf } from './ssl-lines'

/**
 * What the cart page sends to the browser: display strings, already
 * formatted. The client does no money maths, and sees no cost or margin.
 */
export type LineView = {
  id: string
  domain: string
  tld: string
  status: LineStatus
  periodYears: number
  /** A period the registry stopped selling, which the line was moved from. */
  unsoldYears: number | null
  total: string
  /** The renewal price with its term: "₦18,700/yr", or "₦273,000 every 2 years" (N8). */
  renewal: string
  /** A changed line's old and new price, for the diff (FR-C4). */
  was: string | null
  heldUntil: string | null
  includesIcannFee: boolean
  privacyOffered: boolean
  privacy: boolean
  autoRenew: boolean
  periodOptions: { years: number; label: string }[]
  /** Said beside the choice where the registry sells only some periods: "…2, 4, 6, 8 or 10 years". */
  periodNote: string | null
}

const timeFormat = new Intl.DateTimeFormat('en-NG', {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: 'Africa/Lagos',
})

export function toLineView(line: PricedLine, pricing: TldPricing | undefined): LineView {
  // Only the periods the registry sells — for .ai, 2, 4, 6, 8 or 10 years (FR-C2).
  const periodOptions = pricing
    ? pricing.registerPeriods.map((count) => ({
        years: count,
        label: `${yearsText(count)} — ${formatNaira(periodTotalKobo(pricing, count))}`,
      }))
    : [{ years: line.periodYears, label: yearsText(line.periodYears) }]
  const periods = pricing?.registerPeriods ?? []
  const everyYear = periods.length > 0 && periods.every((year, index) => year === index + 1)
  const periodNote =
    pricing && !everyYear && periods.length > 1
      ? `The .${line.tld} registry sells ${periodsText(periods)} at a time.`
      : null

  return {
    id: line.id,
    domain: line.domain,
    tld: line.tld,
    status: line.status,
    periodYears: line.periodYears,
    unsoldYears: line.unsoldYears,
    total: formatNaira(line.payableKobo),
    renewal: formatRenewal(line.renewalKobo, line.renewYears),
    was: line.status === 'changed' ? formatNaira(line.quotedTotalKobo) : null,
    heldUntil: line.heldUntil ? timeFormat.format(new Date(line.heldUntil)) : null,
    includesIcannFee: line.includesIcannFee,
    privacyOffered: line.privacyOffered,
    privacy: line.privacy,
    autoRenew: line.autoRenew,
    periodOptions,
    periodNote,
  }
}

/** An SSL certificate line, as the cart page shows it (FR-SSL-6). */
export type SslLineView = {
  id: string
  /** The site, example.com; the wildcard is said by `covers`. */
  site: string
  /** The supplier name: example.com, or *.example.com. */
  name: string
  productName: string
  kind: SslLineKind
  /** What it covers, in a few words. */
  covers: string
  status: LineStatus
  total: string
  /** N8 — what buying again costs today, said beside the price. Never charged by itself. */
  renewal: string
  term: string
  was: string | null
  heldUntil: string | null
}

export function coversText(kind: SslLineKind, site: string, includedNames: number): string {
  if (kind === 'wildcard') {
    return `Every name one level under ${site} — *.${site}, such as www.${site}`
  }
  if (kind === 'multi') {
    const more = includedNames - 1
    return `${site} and up to ${more} more ${more === 1 ? 'name' : 'names'} under ${namesBase(site)} — you list them when you set it up`
  }
  return `${site} only`
}

export function toSslLineView(line: PricedSslLine): SslLineView {
  const site = siteOf(line)
  return {
    id: line.id,
    site,
    name: line.commonName,
    productName: line.productName,
    kind: line.kind,
    covers: coversText(line.kind, site, line.includedNames),
    status: line.status,
    total: formatNaira(line.payableKobo),
    renewal: SSL_TERM.renewal(formatNaira(line.renewalKobo)),
    term: SSL_TERM.short,
    was: line.status === 'changed' ? formatNaira(line.quotedTotalKobo) : null,
    heldUntil: line.heldUntil ? timeFormat.format(new Date(line.heldUntil)) : null,
  }
}
