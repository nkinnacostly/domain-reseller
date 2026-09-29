import { formatNaira, type PricingInputs, priceCatalogue, type TldRecord } from '@dr/shared'
import { describe, expect, it } from 'vitest'
import {
  canonicalExtensionPath,
  countryName,
  describeKind,
  type ExtensionFacts,
  eligibilityText,
  extensionFaqs,
  extensionKind,
  extensionPrices,
  factsFromPricing,
  icannFeeText,
  lengthText,
  normaliseExtension,
  periodText,
  priceSentence,
} from '../lib/extension'

const INPUTS: PricingInputs = { fxRate: 1333.76, fxBufferPct: 0, marginNgn: 3000, icannFeeUsd: 0.2 }

const record = (name: string, overrides: Partial<TldRecord> = {}): TldRecord => ({
  name,
  registerUsd: 11.31,
  renewUsd: 11.51,
  transferUsd: 10.61,
  restoreUsd: null,
  isCountryCode: false,
  minPeriod: 1,
  maxPeriod: 10,
  redemptionDays: 30,
  requiresExtraFields: false,
  ...overrides,
})

const [COM, PROMO, NOXFER, AI] = priceCatalogue(
  [
    record('com', { renewUsd: 11.31 }),
    record('promo', { registerUsd: 2, renewUsd: 30 }),
    record('noxfer', { transferUsd: null }),
    // .ai as the sync stores it (29 Sept 2026): $99.90 a year, sold in 2- to 10-year blocks.
    record('ai', {
      registerUsd: 99.9,
      renewUsd: 99.9,
      transferUsd: 99.9,
      isCountryCode: true,
      minPeriod: 2,
      registerPeriods: [2, 4, 6, 8, 10],
      renewPeriods: [2, 4, 6, 8, 10],
    }),
  ],
  INPUTS,
)
if (!COM || !PROMO || !NOXFER || !AI) throw new Error('fixture catalogue did not price')

const facts = (overrides: Partial<ExtensionFacts> = {}): ExtensionFacts => ({
  ...factsFromPricing(COM),
  ...overrides,
})

describe('normaliseExtension', () => {
  it('reads an extension however the address spells it', () => {
    expect(normaliseExtension('com')).toBe('com')
    expect(normaliseExtension('COM')).toBe('com')
    expect(normaliseExtension('.com')).toBe('com')
    expect(normaliseExtension('%2Ecom')).toBe('com')
    expect(normaliseExtension('com.ng')).toBe('com.ng')
  })

  it('refuses anything that cannot be an extension', () => {
    for (const raw of ['', '.', 'co m', '-com', 'com-', 'com..ng', '%E0%A4%A', 'a/b']) {
      expect(normaliseExtension(raw), raw).toBeNull()
    }
  })
})

describe('canonicalExtensionPath', () => {
  it('sends a variant spelling to the one page for the extension', () => {
    expect(canonicalExtensionPath('/domains/COM')).toBe('/domains/com')
    expect(canonicalExtensionPath('/domains/.com')).toBe('/domains/com')
    expect(canonicalExtensionPath('/domains/%2Ecom.NG')).toBe('/domains/com.ng')
  })

  it('leaves canonical, invalid and unrelated paths alone', () => {
    for (const path of [
      '/domains/com',
      '/domains/com.ng',
      '/domains/-x',
      '/domains',
      '/app/domains/X.COM',
      '/domains/com/extra',
    ]) {
      expect(canonicalExtensionPath(path), path).toBeNull()
    }
  })
})

describe('countryName', () => {
  it('names the country behind a country code', () => {
    expect(countryName('co')).toBe('Colombia')
    expect(countryName('ng')).toBe('Nigeria')
  })

  it('keeps .uk, the one ccTLD that is not its ISO code', () => {
    expect(countryName('uk')).toBe('United Kingdom')
  })

  it('names nothing it cannot be sure of', () => {
    expect(countryName('zz')).toBeNull()
    expect(countryName('qq')).toBeNull()
    // Retired by ISO: the successor's name would be wrong for .su.
    expect(countryName('su')).toBeNull()
    expect(countryName('com')).toBeNull()
    expect(countryName('1a')).toBeNull()
  })
})

describe('extensionKind and describeKind', () => {
  it('tells generic, country-code and second-level extensions apart', () => {
    expect(extensionKind('com', false)).toEqual({ kind: 'generic' })
    expect(extensionKind('co', true)).toEqual({ kind: 'country', country: 'Colombia' })
    expect(extensionKind('com.ng', true)).toEqual({
      kind: 'second-level',
      parent: 'ng',
      country: 'Nigeria',
    })
    expect(extensionKind('us.com', false)).toEqual({
      kind: 'second-level',
      parent: 'com',
      country: null,
    })
  })

  it('describes each kind in one plain sentence', () => {
    expect(describeKind('com', false)).toBe(
      ".com is a generic extension (gTLD), run under ICANN's rules rather than a country's.",
    )
    expect(describeKind('co', true)).toMatch(
      /^\.co is the country-code extension \(ccTLD\) for Colombia\./,
    )
    expect(describeKind('zz', true)).toMatch(/^\.zz is a country-code extension \(ccTLD\)\./)
    expect(describeKind('com.ng', true)).toBe(
      '.com.ng is a second-level extension under .ng, the country code for Nigeria.',
    )
    expect(describeKind('us.com', false)).toBe('.us.com is a second-level extension under .com.')
  })
})

describe('rules', () => {
  it('says the ICANN fee is included exactly where the pricing engine adds it', () => {
    expect(icannFeeText('com', false)).toMatch(/^Included/)
    expect(icannFeeText('co', true)).toBe(
      'No ICANN fee: country-code extensions such as .co do not carry it.',
    )
  })

  it('states the registration period', () => {
    expect(periodText([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe('1 to 10 years at a time')
    expect(periodText([2])).toBe('2 years at a time')
    expect(periodText([1])).toBe('1 year at a time')
  })

  it('names only the periods a block-sold extension is sold in (.ai)', () => {
    expect(periodText([2, 4, 6, 8, 10])).toBe('2, 4, 6, 8 or 10 years at a time')
    expect(periodText([1, 2, 3, 4, 5, 10])).toBe('1, 2, 3, 4, 5 or 10 years at a time')
  })

  it('states name length only when it is known', () => {
    expect(lengthText(null, null)).toBeNull()
    expect(lengthText(3, 63)).toBe('3 to 63 characters before the dot')
    expect(lengthText(1, null)).toBe('At least 1 character before the dot')
    expect(lengthText(null, 63)).toBe('Up to 63 characters before the dot')
  })

  it('warns about eligibility rules only where the registry has them', () => {
    expect(eligibilityText('com', false)).toMatch(/^None on record/)
    expect(eligibilityText('us', true)).toMatch(/^Eligibility rules apply/)
  })
})

describe('extensionPrices', () => {
  it('withholds every price when there is no priced entry (N5b)', () => {
    expect(extensionPrices(null, true)).toBeNull()
  })

  it('always carries the renewal price with the first-year price (N8)', () => {
    expect(extensionPrices(COM, null)).toEqual({
      register: formatNaira(COM.registration.priceKobo),
      registerYears: 1,
      renew: formatNaira(COM.renewal.priceKobo),
      renewYears: 1,
      transfer: formatNaira(COM.transfer?.priceKobo ?? 0),
      renewalIsHigher: COM.renewalIsHigher,
    })
  })

  it('prices a block-sold extension for its shortest term, never one year (.ai)', () => {
    expect(extensionPrices(AI, null)).toMatchObject({
      register: formatNaira(2 * AI.registration.priceKobo),
      registerYears: 2,
      renew: formatNaira(2 * AI.renewal.priceKobo),
      renewYears: 2,
    })
  })

  it('offers no transfer where there is no transfer price or the supplier refuses transfers', () => {
    expect(extensionPrices(NOXFER, true)?.transfer).toBeNull()
    expect(extensionPrices(COM, false)?.transfer).toBeNull()
  })
})

describe('extensionFaqs', () => {
  const answer = (faqs: { q: string; a: string }[], start: string) =>
    faqs.find((faq) => faq.q.startsWith(start))?.a ?? ''

  it('answers from the data: price, renewal, VAT, period, eligibility, transfer, ICANN', () => {
    const prices = extensionPrices(COM, null)
    const faqs = extensionFaqs({ facts: facts({ minChars: 3, maxChars: 63 }), prices, vatPct: 7.5 })

    expect(answer(faqs, 'How much')).toBe(
      `${prices?.register} for the first year, then ${prices?.renew} a year to renew. Prices are in naira; VAT at 7.5% is added at checkout as its own line.`,
    )
    expect(answer(faqs, 'How long')).toMatch(/^1 to 10 years at a time\./)
    expect(answer(faqs, 'Who can')).toMatch(/^We have no eligibility rules on record for \.com/)
    expect(answer(faqs, 'Who can')).toMatch(/Names can be 3 to 63 characters before the dot\.$/)
    expect(answer(faqs, 'Can I transfer')).toMatch(
      new RegExp(`^Transferring one in costs ${prices?.transfer}`),
    )
    expect(answer(faqs, 'Is the ICANN')).toMatch(/^Yes\./)
  })

  it('words .ai by its real terms: the two-year minimum, renewing every two years', () => {
    const prices = extensionPrices(AI, null)
    const faqs = extensionFaqs({
      facts: factsFromPricing(AI),
      prices,
      vatPct: 7.5,
    })
    const two = formatNaira(2 * AI.registration.priceKobo)
    expect(prices && priceSentence('ai', prices)).toBe(
      `${two} for 2 years (the shortest term .ai allows), then ${two} every 2 years`,
    )
    expect(answer(faqs, 'How much')).toMatch(
      new RegExp(
        `^${two} for 2 years \\(the shortest term \\.ai allows\\), then ${two} every 2 years to renew\\.`,
      ),
    )
    expect(answer(faqs, 'How long')).toMatch(/^2, 4, 6, 8 or 10 years at a time\./)
    expect(answer(faqs, 'Can I transfer')).toMatch(new RegExp(`then ${two} every 2 years\\.`))
    expect(faqs.map((faq) => faq.a).join(' ')).not.toMatch(/a year to renew|\/yr/)
  })

  it('keeps the one-year sentence exactly as it was', () => {
    const prices = extensionPrices(COM, null)
    expect(prices && priceSentence('com', prices)).toBe(
      `${prices?.register} for the first year, then ${prices?.renew} a year`,
    )
  })

  it('says when renewing costs more than the first year', () => {
    const faqs = extensionFaqs({
      facts: facts({ tld: 'promo' }),
      prices: extensionPrices(PROMO, null),
      vatPct: null,
    })
    expect(answer(faqs, 'How much')).toMatch(/Renewing costs more than the first year/)
    expect(answer(faqs, 'How much')).toMatch(/; VAT is added at checkout/)
  })

  it('withholds prices, and says so, when there are none', () => {
    const faqs = extensionFaqs({ facts: facts(), prices: null, vatPct: null })
    expect(answer(faqs, 'How much')).toMatch(/^Prices are briefly unavailable/)
    expect(answer(faqs, 'Can I transfer')).toMatch(/^Transfer prices are briefly unavailable/)
    expect(faqs.map((faq) => faq.a).join(' ')).not.toMatch(/₦/)
  })

  it('covers restricted, country-code and non-transferable extensions', () => {
    const faqs = extensionFaqs({
      facts: facts({ tld: 'noxfer', isCountryCode: true, requiresExtraFields: true }),
      prices: extensionPrices(NOXFER, null),
      vatPct: 7.5,
    })
    expect(answer(faqs, 'Who can')).toMatch(/has eligibility rules/)
    expect(answer(faqs, 'Can I transfer')).toBe("We can't currently transfer .noxfer domains in.")
    expect(answer(faqs, 'Is the ICANN')).toMatch(/^There isn't one/)
  })
})
