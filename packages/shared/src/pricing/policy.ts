import catalogue from './catalogue.json'
import {
  effectiveFxRate,
  ICANN_FEE_USD_PER_YEAR,
  KOBO_PER_NAIRA,
  roundToPsychological,
  VAT_RATE,
} from './index'

/**
 * Retail pricing policy.
 *
 * Wholesale costs come from `catalogue.json`, a snapshot of our live
 * DomainNameAPI catalogue at the `Reseller` tier (verified 20 Sept 2026 —
 * see apps/gateway/scripts/verify-supplier.ts). Regenerate it whenever
 * supplier pricing changes; it is data, never hand-edited.
 */

export type CatalogueEntry = {
  name: string
  register: number
  renew: number
  transfer?: number
  minPeriod: number
  maxPeriod: number
  redemptionDays: number
  requiresExtraFields?: boolean
}

export const CATALOGUE = catalogue as CatalogueEntry[]

export type TradeKind = 'registration' | 'renewal' | 'transfer'

/**
 * Margin is a percentage bounded by a floor and a cap, not a flat rate.
 *
 * A flat percentage fails at both ends: on a $0.99 TLD it earns less than the
 * payment processing costs us, and on a $65 TLD it produces a naira margin no
 * one will pay. The floor covers cost-to-serve; the cap keeps us in the market.
 *
 *  • Registration is customer acquisition, so it runs thin.
 *  • Renewal is where a registrar actually earns — but only far enough that we
 *    can still show the renewal price next to the first-year price without
 *    embarrassment (PRD N8). Renewal shock is the thing we promised not to do.
 *  • Transfer wins portfolios, so it is close to cost.
 */
export type MarginBand = {
  marginPct: number
  /** Minimum gross profit, naira. Must clear payment fees and cost-to-serve. */
  floorNgn: number
  /** Maximum gross profit, naira. Stops expensive TLDs pricing themselves out. */
  capNgn: number
}

export const DEFAULT_BANDS: Record<TradeKind, MarginBand> = {
  registration: { marginPct: 18, floorNgn: 1800, capNgn: 12_000 },
  renewal: { marginPct: 25, floorNgn: 2500, capNgn: 18_000 },
  transfer: { marginPct: 10, floorNgn: 1200, capNgn: 8000 },
}

/**
 * Per-TLD overrides.
 *
 * `.com`, `.net` and `.org` are global commodities that buyers price-compare to
 * the cent. Our wholesale cost for `.com` is USD 11.31 — above what several
 * international registrars *retail* it for — so we carry them at a thin margin
 * rather than pretending to be cheapest. See PRD risk R17.
 *
 * The `.ng` family is the strategic range: priced to be worth choosing, not to
 * extract the most per sale.
 */
export const TLD_OVERRIDES: Partial<
  Record<string, Partial<Record<TradeKind, Partial<MarginBand>>>>
> = {
  com: {
    registration: { marginPct: 8, floorNgn: 1200 },
    renewal: { marginPct: 12, floorNgn: 1500 },
  },
  net: {
    registration: { marginPct: 8, floorNgn: 1200 },
    renewal: { marginPct: 12, floorNgn: 1500 },
  },
  org: {
    registration: { marginPct: 10, floorNgn: 1200 },
    renewal: { marginPct: 12, floorNgn: 1500 },
  },
  // The .ng family costs the same to register and to renew, and we keep it
  // that way: identical margins on both. A flagship extension that renews
  // higher than year one would undercut the promise the storefront is built
  // on. "The same price every year" is worth more than the extra few percent.
  ng: { registration: { marginPct: 20 }, renewal: { marginPct: 20 } },
  'com.ng': { registration: { marginPct: 20 }, renewal: { marginPct: 20 } },
  'org.ng': { registration: { marginPct: 20 }, renewal: { marginPct: 20 } },
  'net.ng': { registration: { marginPct: 20 }, renewal: { marginPct: 20 } },
}

export function bandFor(tld: string, kind: TradeKind): MarginBand {
  return { ...DEFAULT_BANDS[kind], ...(TLD_OVERRIDES[tld]?.[kind] ?? {}) }
}

/**
 * ccTLDs carry no ICANN transaction fee; gTLDs do.
 *
 * A country-code TLD is a two-letter final label — `ng`, `io`, `co`, and the
 * second-level `com.ng`, whose registry is NiRA rather than a gTLD registry.
 * Everything longer is a gTLD.
 */
export function isCountryCodeTld(name: string): boolean {
  const last = name.split('.').pop() ?? ''
  return last.length === 2
}

export function icannFeeApplies(name: string): boolean {
  return !isCountryCodeTld(name)
}

export type Quote = {
  tld: string
  kind: TradeKind
  /** Landed wholesale cost including any ICANN fee, in kobo. */
  costKobo: number
  /** What the customer pays before VAT, in kobo. */
  priceKobo: number
  /** VAT at 7.5%, in kobo. */
  vatKobo: number
  /** Price including VAT, in kobo. */
  totalKobo: number
  /** Gross profit before payment fees, in kobo. */
  marginKobo: number
  /** Gross margin as a percentage of the ex-VAT price. */
  marginPctOfPrice: number
}

export type FxSettings = { midRate: number; bufferPct: number }

export function quote(entry: CatalogueEntry, kind: TradeKind, fx: FxSettings): Quote | null {
  const costUsd =
    kind === 'registration' ? entry.register : kind === 'renewal' ? entry.renew : entry.transfer

  // Not every TLD is transferable in, and the supplier does not price them all.
  if (typeof costUsd !== 'number' || costUsd <= 0) return null

  const rate = effectiveFxRate(fx.midRate, fx.bufferPct)
  const icannUsd = icannFeeApplies(entry.name) ? ICANN_FEE_USD_PER_YEAR : 0
  const costKobo = Math.round((costUsd + icannUsd) * rate * KOBO_PER_NAIRA)

  const band = bandFor(entry.name, kind)
  const rawMargin = costKobo * (band.marginPct / 100)
  const marginKobo = Math.min(
    Math.max(rawMargin, band.floorNgn * KOBO_PER_NAIRA),
    band.capNgn * KOBO_PER_NAIRA,
  )

  const priceKobo = roundToPsychological(costKobo + marginKobo)
  const vatKobo = Math.round(priceKobo * VAT_RATE)

  return {
    tld: entry.name,
    kind,
    costKobo,
    priceKobo,
    vatKobo,
    totalKobo: priceKobo + vatKobo,
    marginKobo: priceKobo - costKobo,
    marginPctOfPrice: ((priceKobo - costKobo) / priceKobo) * 100,
  }
}

export type TldPricing = {
  tld: string
  isCountryCode: boolean
  minPeriod: number
  maxPeriod: number
  redemptionDays: number
  requiresExtraFields: boolean
  registration: Quote
  renewal: Quote
  transfer: Quote | null
  /** True when renewal costs materially more than the first year. */
  renewalIsHigher: boolean
}

export function priceCatalogue(fx: FxSettings): TldPricing[] {
  const out: TldPricing[] = []

  for (const entry of CATALOGUE) {
    const registration = quote(entry, 'registration', fx)
    const renewal = quote(entry, 'renewal', fx)
    if (!registration || !renewal) continue

    out.push({
      tld: entry.name,
      isCountryCode: isCountryCodeTld(entry.name),
      minPeriod: entry.minPeriod,
      maxPeriod: entry.maxPeriod,
      redemptionDays: entry.redemptionDays,
      requiresExtraFields: entry.requiresExtraFields ?? false,
      registration,
      renewal,
      transfer: quote(entry, 'transfer', fx),
      renewalIsHigher: renewal.priceKobo > registration.priceKobo,
    })
  }

  return out
}

export function findTld(name: string): CatalogueEntry | undefined {
  return CATALOGUE.find((entry) => entry.name === name)
}
