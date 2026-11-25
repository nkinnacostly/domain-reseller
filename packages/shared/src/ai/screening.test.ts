import { describe, expect, it } from 'vitest'
import {
  cleanScreeningReason,
  SCREENING_BRANDS,
  SCREENING_LURES,
  SCREENING_REASON_MAX,
  screeningAnswer,
  screeningMatches,
  screeningRequest,
} from './screening'

describe('screeningMatches', () => {
  it('finds a brand and its lure in a sign-in name', () => {
    expect(screeningMatches('paypal-login.com')).toEqual({ brands: ['paypal'], lures: ['login'] })
    expect(screeningMatches('GTBank-Verify.com.ng')).toEqual({
      brands: ['gtbank'],
      lures: ['verify'],
    })
  })

  it('reads hyphens as nothing and digits as the letters they imitate', () => {
    expect(screeningMatches('pay-pal.com').brands).toEqual(['paypal'])
    expect(screeningMatches('paypa1-secure.net')).toEqual({ brands: ['paypal'], lures: ['secure'] })
    expect(screeningMatches('g00gle.com').brands).toEqual(['google'])
  })

  it('matches a short brand only as a whole word', () => {
    expect(screeningMatches('uba-refund.com')).toEqual({ brands: ['uba'], lures: ['refund'] })
    expect(screeningMatches('my.bvn.ng').brands).toEqual(['bvn'])
    expect(screeningMatches('cubacigars.com').brands).toEqual([])
    expect(screeningMatches('globaltraders.com').brands).toEqual([])
    expect(screeningMatches('supsupplies.com').brands).toEqual([])
  })

  it('leaves an ordinary name clear, a lure alone included', () => {
    expect(screeningMatches('ibadanbakes.com')).toEqual({ brands: [], lures: [] })
    expect(screeningMatches('securelogin.com')).toEqual({ brands: [], lures: ['login', 'secure'] })
  })

  it('ignores the extension', () => {
    expect(screeningMatches('example.meta').brands).toEqual([])
    expect(screeningMatches('nomatch').brands).toEqual([])
  })

  it('keeps every listed word lower-case and unique', () => {
    for (const list of [SCREENING_BRANDS, SCREENING_LURES]) {
      expect(new Set(list).size).toBe(list.length)
      for (const word of list) expect(word).toMatch(/^[a-z0-9]+$/)
    }
  })
})

describe('screeningRequest', () => {
  it('sends the name and its matches, nothing else', () => {
    const request = screeningRequest(' PayPal-Login.com ', ['paypal', 'login'])
    expect(request.user).toBe('Domain: paypal-login.com\nContains: paypal, login')
    expect(request.system).toContain('json')
    expect(request.temperature).toBe(0)
  })
})

describe('screeningAnswer', () => {
  it('takes only clear or review', () => {
    expect(screeningAnswer.safeParse({ verdict: 'review', reason: 'x' }).success).toBe(true)
    expect(screeningAnswer.safeParse({ verdict: 'block', reason: 'x' }).success).toBe(false)
  })
})

describe('cleanScreeningReason', () => {
  it('makes one line and cuts it to fit', () => {
    expect(cleanScreeningReason('  Looks like\n a PayPal  page ')).toBe('Looks like a PayPal page')
    expect(cleanScreeningReason('x'.repeat(500))).toHaveLength(SCREENING_REASON_MAX)
    expect(cleanScreeningReason('   ')).toBeNull()
  })
})
