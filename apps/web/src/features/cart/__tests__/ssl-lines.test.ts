import { describe, expect, it } from 'vitest'
import { cartTotals } from '../lib/lines'
import { priceSslLine, siteOf, sslKind } from '../lib/ssl-lines'
import { coversText, toSslLineView } from '../lib/view'

/** FR-SSL-6, FR-C4: a certificate in the cart holds its quote, then follows today's price. */

const NOW = new Date('2026-10-02T12:00:00Z')
const LINE = {
  id: 'ssl-1',
  productCode: '351',
  commonName: 'shop.example.com',
  quotedTotalKobo: 1_350_000,
  quotedAt: '2026-10-02T11:50:00Z',
}
const PRODUCT = {
  productCode: '351',
  name: 'Sectigo PositiveSSL Certificate',
  vendor: 'Sectigo',
  validationType: 'DV',
  isWildcard: false,
  isMultiDomain: false,
  includedNames: 1,
  isReissueFree: true,
  createUsd: 6.99,
  price: { costKobo: 1_048_500, priceKobo: 1_350_000, marginKobo: 301_500 },
}

describe('pricing an SSL line', () => {
  it('holds the quote inside the lock window, whatever the price did', () => {
    const priced = priceSslLine(
      LINE,
      { ...PRODUCT, price: { ...PRODUCT.price, priceKobo: 1_400_000 } },
      NOW,
      30,
    )
    expect(priced).toMatchObject({ status: 'held', payableKobo: 1_350_000, renewalKobo: 1_400_000 })
    expect(priced.heldUntil).toBe('2026-10-02T12:20:00.000Z')
  })

  it('after the window, pays today’s price — and asks for a changed one to be accepted', () => {
    const late = { ...LINE, quotedAt: '2026-10-02T10:00:00Z' }
    expect(priceSslLine(late, PRODUCT, NOW, 30)).toMatchObject({
      status: 'current',
      payableKobo: 1_350_000,
      heldUntil: null,
    })
    expect(
      priceSslLine(
        late,
        { ...PRODUCT, price: { ...PRODUCT.price, priceKobo: 1_400_000 } },
        NOW,
        30,
      ),
    ).toMatchObject({ status: 'changed', payableKobo: 1_400_000, currentKobo: 1_400_000 })
  })

  it('marks a certificate we no longer sell, and pays nothing for it', () => {
    expect(
      priceSslLine({ ...LINE, commonName: '*.example.com' }, undefined, NOW, 30),
    ).toMatchObject({
      status: 'unavailable',
      payableKobo: 0,
      kind: 'wildcard',
    })
  })

  it('knows the three kinds and the site behind a wildcard', () => {
    expect(sslKind({ isWildcard: false, isMultiDomain: false })).toBe('single')
    expect(sslKind({ isWildcard: true, isMultiDomain: false })).toBe('wildcard')
    expect(sslKind({ isWildcard: true, isMultiDomain: true })).toBe('multi')
    expect(siteOf({ commonName: '*.example.com' })).toBe('example.com')
  })
})

describe('a cart with domains and certificates', () => {
  it('adds them up alike, VAT once, and flags a change in either', () => {
    const certificate = priceSslLine(
      { ...LINE, quotedAt: '2026-10-02T10:00:00Z' },
      PRODUCT,
      NOW,
      30,
    )
    const totals = cartTotals([], (amount) => Math.round(amount * 0.075), [certificate])
    expect(totals).toEqual({
      subtotalKobo: 1_350_000,
      vatKobo: 101_250,
      totalKobo: 1_451_250,
      needsAcknowledgement: false,
      unavailableCount: 0,
    })
    const changed = cartTotals([], () => 0, [
      { status: 'changed', payableKobo: 1 },
      { status: 'unavailable', payableKobo: 0 },
    ])
    expect(changed).toMatchObject({
      needsAcknowledgement: true,
      unavailableCount: 1,
      subtotalKobo: 1,
    })
  })
})

describe('an SSL line as the cart shows it', () => {
  it('says what it covers, its term, and what buying again costs (N8)', () => {
    const view = toSslLineView(priceSslLine(LINE, PRODUCT, NOW, 30))
    expect(view).toMatchObject({
      name: 'shop.example.com',
      site: 'shop.example.com',
      productName: 'Sectigo PositiveSSL Certificate',
      covers: 'shop.example.com only',
      total: '₦13,500',
      term: '1-year subscription',
      status: 'held',
      was: null,
    })
    expect(view.renewal).toMatch(/never renews by itself.*₦13,500/)
    expect(view.heldUntil).toMatch(/1:20/)
  })

  it('words a wildcard and a multi-domain certificate by what they cover', () => {
    expect(coversText('wildcard', 'example.com', 1)).toBe(
      'Every name one level under example.com — *.example.com, such as www.example.com',
    )
    expect(coversText('multi', 'www.example.com', 4)).toBe(
      'www.example.com and up to 3 more names under example.com — you list them when you set it up',
    )
    expect(coversText('multi', 'example.com', 2)).toMatch(/up to 1 more name under/)
  })

  it('shows the old price beside the new one when it changed', () => {
    const view = toSslLineView(
      priceSslLine(
        { ...LINE, quotedAt: '2026-10-01T10:00:00Z', quotedTotalKobo: 1_300_000 },
        PRODUCT,
        NOW,
        30,
      ),
    )
    expect(view).toMatchObject({
      status: 'changed',
      was: '₦13,000',
      total: '₦13,500',
      heldUntil: null,
    })
  })
})
