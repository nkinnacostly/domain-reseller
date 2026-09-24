import { formatNaira, type TldPricing } from '@dr/shared'

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

export function periodText(minPeriod: number, maxPeriod: number): string {
  const years = (n: number) => `${n} ${n === 1 ? 'year' : 'years'}`
  return minPeriod === maxPeriod
    ? `${years(minPeriod)} at a time`
    : `${minPeriod} to ${years(maxPeriod)} at a time`
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
  register: string
  /** N8: always shown beside the first-year price. */
  renew: string
  /** Null when we cannot transfer this extension in. */
  transfer: string | null
  renewalIsHigher: boolean
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
    register: formatNaira(pricing.registration.priceKobo),
    renew: formatNaira(pricing.renewal.priceKobo),
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
        ? `${prices.register} for the first year, then ${prices.renew} a year to renew.${
            prices.renewalIsHigher
              ? ' Renewing costs more than the first year for this extension, so plan for the higher figure.'
              : ''
          } Prices are in naira; ${vat} is added at checkout as its own line.`
        : 'Prices are briefly unavailable. We would rather show you nothing than a wrong figure — try again in a few minutes.',
    },
    {
      q: `How long can I register a .${tld} domain for?`,
      a: `${periodText(facts.minPeriod, facts.maxPeriod).replace(/^./, (c) => c.toUpperCase())}. You choose the number of years in your cart, and you can renew from your account before it expires.`,
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
          ? `Transferring one in costs ${prices.transfer}, then ${prices.renew} a year. Our transfer page checks whether your domain can move and tells you what, if anything, is in the way.`
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
