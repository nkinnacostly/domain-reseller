import { describe, expect, it } from 'vitest'
import { llmsFullTxt, llmsTxt, type PriceLine } from '../lib/llms'

const SITE = 'https://www.mydomainshub.com'
const COM: PriceLine = {
  tld: 'com',
  register: '₦18,300',
  registerYears: 1,
  renew: '₦18,600',
  renewYears: 1,
  transfer: '₦17,000',
}
const AFRICA: PriceLine = {
  tld: 'africa',
  register: '₦21,000',
  registerYears: 1,
  renew: '₦21,000',
  renewYears: 1,
  transfer: null,
}
/** .ai: sold only in blocks, so its prices are for the whole term. */
const AI: PriceLine = {
  tld: 'ai',
  register: '₦273,000',
  registerYears: 2,
  renew: '₦273,000',
  renewYears: 2,
  transfer: '₦136,500',
}
const prices = { vatPct: 7.5, extensionCount: 691, popular: [COM, AFRICA] }

describe('llms.txt (llmstxt.org)', () => {
  const text = llmsTxt({ site: SITE, prices })

  it('opens with the name as the only H1, then a one-paragraph summary', () => {
    const lines = text.split('\n')
    expect(lines[0]).toBe('# MyDomainsHub')
    expect(lines.filter((line) => line.startsWith('# '))).toHaveLength(1)
    expect(lines[2]).toMatch(
      /^> Domain name registration for Nigeria\. Search 691 domain extensions/,
    )
  })

  it('states who runs it and that it is a reseller (CMP-1)', () => {
    expect(text).toContain('CLOOP UNIVERSE TECH')
    expect(text).toContain('not itself ICANN-accredited')
  })

  it('gives every price with its renewal price (N8), linked to the extension page', () => {
    const priceLines = text.split('\n').filter((line) => line.includes('for the first year'))
    expect(priceLines).toHaveLength(2)
    for (const line of priceLines) expect(line).toMatch(/then ₦[\d,]+ a year to renew/)
    expect(text).toContain(
      `- [.com](${SITE}/domains/com): ₦18,300 for the first year, then ₦18,600 a year to renew; transfer in ₦17,000`,
    )
  })

  it('states a block-sold extension by its real terms, never a year it does not sell (.ai)', () => {
    const withAi = llmsTxt({ site: SITE, prices: { ...prices, popular: [COM, AI] } })
    expect(withAi).toContain(
      `- [.ai](${SITE}/domains/ai): ₦273,000 for 2 years (the shortest term .ai allows), then ₦273,000 every 2 years to renew; transfer in ₦136,500`,
    )
  })

  it('says prices are unavailable rather than guessing (N5b)', () => {
    const withheld = llmsTxt({ site: SITE, prices: null })
    expect(withheld).toContain('Prices are briefly unavailable')
    expect(withheld).not.toMatch(/₦/)
  })

  it('links only to absolute addresses on the site, with an Optional section last', () => {
    for (const [, url] of text.matchAll(/\]\(([^)]+)\)/g))
      expect(url).toMatch(/^https:\/\/www\.mydomainshub\.com\//)
    const sections = [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1])
    expect(sections.at(-1)).toBe('Optional')
  })
})

describe('llms-full.txt', () => {
  it('lists every extension and repeats the answers word for word', () => {
    const text = llmsFullTxt({
      site: SITE,
      prices,
      all: [AFRICA, COM],
      faqs: [{ title: 'Help: Buying a domain', items: [{ q: 'How can I pay?', a: 'By card.' }] }],
    })
    expect(text).toContain('## Every extension')
    expect(text).toContain(
      `[.africa](${SITE}/domains/africa): ₦21,000 for the first year, then ₦21,000 a year to renew`,
    )
    expect(text).toContain('## Help: Buying a domain\n\n### How can I pay?\n\nBy card.')
  })
})
