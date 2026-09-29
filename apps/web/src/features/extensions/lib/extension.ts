import { formatNaira, type TldPricing, yearsBetween } from '@dr/shared'
import { firstTermPhrase, periodsText, renewalPhrase } from '@/features/pricing/lib/terms'

/**
 * Per-extension landing pages (PRD FR-PUB1). Pure: the page reads the
 * catalogue and the priced catalogue, and everything it says about an
 * extension is derived here from those two — nothing is typed in per
 * extension except the tagline the database already holds.
 */

/** What the catalogue records about an extension, apart from its costs. */
export type ExtensionFacts = {
  tld: string
  isCountryCode: boolean
  minPeriod: number
  maxPeriod: number
  /** Years a registration can be bought for — every year from min to max for most. */
  registerPeriods: number[]
  requiresExtraFields: boolean
  /** Shortest and longest name the registry accepts. Null: not known yet. */
  minChars: number | null
  maxChars: number | null
  /** Whether the supplier accepts transfers in. Null: not known yet. */
  isTransferable: boolean | null
  /** Merchandising line from `tlds.featured_tagline`. */
  tagline: string | null
}

/** The same facts, from the priced catalogue, for when the catalogue read fails. */
export function factsFromPricing(pricing: TldPricing): ExtensionFacts {
  return {
    tld: pricing.tld,
    isCountryCode: pricing.isCountryCode,
    minPeriod: pricing.minPeriod,
    maxPeriod: pricing.maxPeriod,
    registerPeriods: pricing.registerPeriods,
    requiresExtraFields: pricing.requiresExtraFields,
    minChars: null,
    maxChars: null,
    isTransferable: null,
    tagline: null,
  }
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

/**
 * The extension a URL segment names — lowercased, without a leading dot — or
 * null when it cannot be one. `/domains/.COM` and `/domains/com` are the same
 * page; the caller redirects to this form.
 */
export function normaliseExtension(raw: string): string | null {
  let value: string
  try {
    value = decodeURIComponent(raw)
  } catch {
    return null
  }
  value = value.trim().toLowerCase().replace(/^\.+/, '')
  if (!value) return null
  return value.split('.').every((label) => LABEL.test(label)) ? value : null
}

/**
 * Where a non-canonical extension address belongs: `/domains/COM` and
 * `/domains/.com` → `/domains/com`. Null when the path is already canonical,
 * is not an extension page, or names nothing that could be an extension.
 *
 * The proxy redirects before the page renders. Rendering the variant instead
 * would keep it as a page of its own — and on a case-insensitive disk (macOS)
 * `COM` overwrites the prerendered `com`.
 */
export function canonicalExtensionPath(pathname: string): string | null {
  const match = pathname.match(/^\/domains\/([^/]+)\/?$/)
  if (!match?.[1]) return null
  const tld = normaliseExtension(match[1])
  return tld && tld !== match[1] ? `/domains/${tld}` : null
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' })

/**
 * The country a two-letter code stands for, or null when we cannot be sure.
 * A code ISO has retired is renamed to its successor (.su would read as
 * Russia), so it names nothing; .uk is the one ccTLD that is not its ISO code
 * (GB), and is kept.
 */
export function countryName(code: string): string | null {
  if (!/^[a-z]{2}$/.test(code)) return null
  const region = code.toUpperCase()
  const [canonical] = Intl.getCanonicalLocales(`und-${region}`)
  if (canonical !== `und-${region}` && code !== 'uk') return null
  const name = regionNames.of(region)
  return name && name !== 'Unknown Region' ? name : null
}

export type ExtensionKind =
  | { kind: 'generic' }
  | { kind: 'country'; country: string | null }
  | { kind: 'second-level'; parent: string; country: string | null }

export function extensionKind(tld: string, isCountryCode: boolean): ExtensionKind {
  const labels = tld.split('.')
  const last = labels.at(-1) ?? tld
  if (labels.length > 1) {
    return { kind: 'second-level', parent: last, country: isCountryCode ? countryName(last) : null }
  }
  return isCountryCode ? { kind: 'country', country: countryName(tld) } : { kind: 'generic' }
}

/** One sentence on what kind of extension this is. */
export function describeKind(tld: string, isCountryCode: boolean): string {
  const kind = extensionKind(tld, isCountryCode)
  switch (kind.kind) {
    case 'generic':
      return `.${tld} is a generic extension (gTLD), run under ICANN's rules rather than a country's.`
    case 'country':
      return kind.country
        ? `.${tld} is the country-code extension (ccTLD) for ${kind.country}. Its registry sets its own rules rather than ICANN's.`
        : `.${tld} is a country-code extension (ccTLD). Its registry sets its own rules rather than ICANN's.`
    case 'second-level':
      return kind.country
        ? `.${tld} is a second-level extension under .${kind.parent}, the country code for ${kind.country}.`
        : `.${tld} is a second-level extension under .${kind.parent}.`
  }
}

/**
 * Mirrors the pricing engine, which adds the ICANN fee to every extension
 * that is not a country code — so the page says exactly what the price holds.
 */
export function icannFeeText(tld: string, isCountryCode: boolean): string {
  return isCountryCode
    ? `No ICANN fee: country-code extensions such as .${tld} do not carry it.`
    : 'Included: ICANN charges a small yearly fee on generic extensions, and it is already in the prices shown.'
}

/**
 * "1 to 10 years at a time", or for .ai "2, 4, 6, 8 or 10 years at a time" —
 * only the periods the registry sells.
 */
export function periodText(registerPeriods: readonly number[]): string {
  return `${periodsText(registerPeriods)} at a time`
}

/** The periods a catalogue row sells, as the priced catalogue reads them (see soldPeriods). */
export function registerPeriodsOf(row: {
  min_period: number
  max_period: number
  register_periods?: readonly number[] | null
}): number[] {
  return row.register_periods
    ? [...row.register_periods].map(Number)
    : yearsBetween(Number(row.min_period), Number(row.max_period))
}

/** Null when the registry's length rules are not known yet — nothing is guessed. */
export function lengthText(minChars: number | null, maxChars: number | null): string | null {
  const chars = (n: number) => `${n} ${n === 1 ? 'character' : 'characters'}`
  if (minChars !== null && maxChars !== null) {
    return `${minChars} to ${chars(maxChars)} before the dot`
  }
  if (minChars !== null) return `At least ${chars(minChars)} before the dot`
  if (maxChars !== null) return `Up to ${chars(maxChars)} before the dot`
  return null
}

export function eligibilityText(tld: string, requiresExtraFields: boolean): string {
  return requiresExtraFields
    ? `Eligibility rules apply: the .${tld} registry asks for more than your contact details. Check that you qualify before you buy, and email us if you are not sure.`
    : 'None on record: the registry asks only for your contact details.'
}

/** Display strings only — the page does no money maths (N5). */
export type ExtensionPrices = {
  /** The shortest registration, for `registerYears` years: the first year for most. */
  register: string
  registerYears: number
  /** N8: always shown beside the first price. The shortest renewal, for `renewYears` years. */
  renew: string
  renewYears: number
  /** Null when we cannot transfer this extension in. */
  transfer: string | null
  renewalIsHigher: boolean
}

/**
 * "₦18,300 for the first year, then ₦18,700 a year" — or, where the registry
 * sells no single year, "₦273,000 for 2 years (the shortest term .ai allows),
 * then ₦273,000 every 2 years". The page, its metadata and its markup share it.
 */
export function priceSentence(tld: string, prices: ExtensionPrices): string {
  return `${firstTermPhrase(tld, prices.register, prices.registerYears)}, then ${renewalPhrase(prices.renew, prices.renewYears)}`
}

/**
 * Null when prices must be withheld (N5b). A transfer price shows only when
 * the catalogue has one and the supplier has not said transfers are refused.
 */
export function extensionPrices(
  pricing: TldPricing | null,
  isTransferable: boolean | null,
): ExtensionPrices | null {
  if (!pricing) return null
  return {
    register: formatNaira(pricing.firstTerm.priceKobo),
    registerYears: pricing.firstTerm.years,
    renew: formatNaira(pricing.renewalTerm.priceKobo),
    renewYears: pricing.renewalTerm.years,
    transfer:
      pricing.transfer && isTransferable !== false ? formatNaira(pricing.transfer.priceKobo) : null,
    renewalIsHigher: pricing.renewalIsHigher,
  }
}

export type Faq = { q: string; a: string }

export function extensionFaqs({
  facts,
  prices,
  vatPct,
}: {
  facts: ExtensionFacts
  prices: ExtensionPrices | null
  vatPct: number | null
}): Faq[] {
  const { tld } = facts
  const vat = vatPct === null ? 'VAT' : `VAT at ${vatPct}%`
  const length = lengthText(facts.minChars, facts.maxChars)

  return [
    {
      q: `How much is a .${tld} domain?`,
      a: prices
        ? `${priceSentence(tld, prices)} to renew.${
            prices.renewalIsHigher
              ? ' Renewing costs more than the first year for this extension, so plan for the higher figure.'
              : ''
          } Prices are in naira; ${vat} is added at checkout as its own line.`
        : 'Prices are briefly unavailable. We would rather show you nothing than a wrong figure — try again in a few minutes.',
    },
    {
      q: `How long can I register a .${tld} domain for?`,
      a: `${periodText(facts.registerPeriods).replace(/^./, (c) => c.toUpperCase())}. You choose the number of years in your cart, and you can renew from your account before it expires.`,
    },
    {
      q: `Who can register a .${tld} domain?`,
      a: `${
        facts.requiresExtraFields
          ? `The .${tld} registry has eligibility rules and asks for more than your contact details, so check that you qualify before you buy. Email us if you are not sure.`
          : `We have no eligibility rules on record for .${tld}: the registry asks only for your contact details.`
      }${length ? ` Names can be ${length.charAt(0).toLowerCase()}${length.slice(1)}.` : ''}`,
    },
    {
      q: `Can I transfer a .${tld} domain I already own?`,
      a: !prices
        ? 'Transfer prices are briefly unavailable. Try again in a few minutes.'
        : prices.transfer
          ? `Transferring one in costs ${prices.transfer}, then ${renewalPhrase(prices.renew, prices.renewYears)}. Our transfer page checks whether your domain can move and tells you what, if anything, is in the way.`
          : `We can't currently transfer .${tld} domains in.`,
    },
    {
      q: 'Is the ICANN fee included?',
      a: facts.isCountryCode
        ? `There isn't one: country-code extensions such as .${tld} do not carry ICANN's fee.`
        : 'Yes. ICANN charges a small yearly fee on generic extensions, and it is already in the prices shown.',
    },
  ]
}
