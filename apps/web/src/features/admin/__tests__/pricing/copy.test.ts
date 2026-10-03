import { describe, expect, it } from 'vitest'
import { ADMIN_ERROR_WORDS } from '@/features/admin/lib/errors'
import { formatWat } from '@/features/admin/lib/format'
import {
  activateCopy,
  arrivalWords,
  BLOCK_DETAIL,
  buildSteps,
  catalogueHints,
  changeValue,
  chargedWords,
  effectLine,
  exampleLine,
  FIELD_HINT,
  formatIcannFee,
  formatMargin,
  formatMove,
  formatPercent,
  formatRate,
  noExampleWords,
  noneHeldWords,
  rateHeading,
  rejectCopy,
  saveCopy,
  settingNote,
  settingValue,
  TOO_OLD,
  VAT_READ_ONLY,
} from '@/features/admin/lib/pricing-copy'
import {
  chargedRate,
  movePct,
  priceEffect,
  pricingInputs,
  settingsAfter,
  termsAt,
} from '@/features/admin/lib/pricing-rules'
import { aiSample, comSample, freshRow, rateRow, settings, staleRow, status } from './fixtures'

/**
 * The Pricing & FX pages' words (docs/ADMIN-SPEC.md §5.2 B12), exactly. The
 * fixtures hold no default figure — a ₦4,250 margin, an 18-cent ICANN fee, a
 * 6.5% threshold — so every number below was interpolated, never written in
 * (N5b). Every price is shown with its renewal (N8), and nothing claims a
 * mechanism the code does not have (N9b).
 */

const charged = (row: ReturnType<typeof rateRow>) => ({ ...row, charged: chargedRate(row) })

describe('figures', () => {
  it('writes rates, percentages, moves, the margin and the fee at the display edge', () => {
    expect(formatRate(1330.5689)).toBe('₦1,330.57')
    expect(formatRate(1768)).toBe('₦1,768.00')
    expect(formatRate(null)).toBe('—')
    expect(formatRate(Number.NaN)).toBe('—')
    expect(formatPercent(7.5)).toBe('7.5%')
    expect(formatPercent(4)).toBe('4%')
    expect(formatPercent(4.25)).toBe('4.25%')
    expect(formatPercent(undefined)).toBe('—')
    expect(formatMove(20.5674)).toBe('+20.6%')
    expect(formatMove(-4.3896)).toBe('−4.4%')
    expect(formatMove(0.04)).toBe('0.0%')
    expect(formatMove(null)).toBe('—')
    expect(formatMargin(4250)).toBe('₦4,250')
    expect(formatIcannFee(18)).toBe('$0.18')
    expect(rateHeading(1700)).toBe('₦1,700.00 to the dollar')
  })

  it('shows each stored setting and each typed one in its own unit', () => {
    const current = settings()
    expect(settingValue('margin_ngn', current)).toBe('₦4,250')
    expect(settingValue('fx_buffer_pct', current)).toBe('1.5%')
    expect(settingValue('icann_fee_cents', current)).toBe('$0.18')
    expect(settingValue('fx_move_threshold_pct', current)).toBe('6.5%')
    expect(changeValue('margin_ngn', 5000)).toBe('₦5,000')
    expect(changeValue('icann_fee_cents', 0)).toBe('$0.00')
    expect(changeValue('fx_buffer_pct', 2.25)).toBe('2.25%')
  })

  it("names a rate's buffer only when it has one", () => {
    expect(chargedWords(1700, 4, 1768)).toBe('₦1,768.00: ₦1,700.00 plus its 4% buffer')
    expect(chargedWords(1330.5689, 0, 1330.5689)).toBe('₦1,330.57 (no buffer)')
  })
})

describe('the pricing page', () => {
  it('says VAT is read-only, in the spec’s words', () => {
    expect(VAT_READ_ONLY).toBe("VAT is a statutory rate; it's changed in the SQL editor.")
    expect(settingNote('vat_pct', null)).toBe(VAT_READ_ONLY)
  })

  it('says what each setting does, the active rate’s own buffer included', () => {
    expect(settingNote('margin_ngn', null)).toBe(
      'Added to every domain and SSL certificate price, before rounding up to the next ₦100.',
    )
    expect(settingNote('fx_buffer_pct', 0)).toBe(
      'Added to each rate the FX job fetches. The active rate carries its own: 0%.',
    )
    expect(settingNote('fx_buffer_pct', null)).toBe('Added to each rate the FX job fetches.')
    expect(settingNote('icann_fee_cents', null)).toBe(
      'A year, on generic extensions only — not on country codes such as .ng, nor on SSL certificates.',
    )
    expect(settingNote('fx_move_threshold_pct', null)).toBe(
      'A fetched rate that moves further than this from the active one is held for review.',
    )
  })

  it('builds a price in steps, with today’s figures', () => {
    const active = charged(rateRow())
    expect(buildSteps({ settings: settings(), active })).toEqual([
      "A year's cost from DomainNameAPI's catalogue, which the gateway syncs every week,",
      'plus the ICANN fee — $0.18 a year — on generic extensions,',
      'at the active rate, ₦1,330.57 to the dollar,',
      'plus the margin, ₦4,250,',
      'rounded up to the next ₦100: one year’s price.',
      'A longer registration is the first term at that price and each later year at the renewal price. SSL certificates are priced the same way, without the ICANN fee. VAT (7.5%) is added at checkout, never in list prices.',
    ])
    const buffered = charged(rateRow({ costingRate: 1700, bufferPct: 4 }))
    expect(buildSteps({ settings: settings(), active: buffered })[2]).toBe(
      'at the active rate plus its 4% buffer, ₦1,768.00 to the dollar,',
    )
    expect(buildSteps({ settings: settings(), active: null })[2]).toBe(
      'at the active exchange rate — there is none, so the site shows no prices —',
    )
  })

  it('gives the example with its renewal, and a block-sold term as a block (N8)', () => {
    const inputs = pricingInputs(rateRow(), settings())
    const com = termsAt(comSample(), inputs)
    const ai = termsAt(aiSample(), inputs)
    if (!com || !ai) throw new Error('no price')
    expect(exampleLine('com', com)).toBe('.com today: ₦19,600 for the first year, then ₦19,900/yr.')
    expect(exampleLine('ai', ai)).toBe(
      '.ai today: ₦274,400 for the first 2 years, then ₦274,400 every 2 years.',
    )
  })

  it('says why there is no example', () => {
    expect(noExampleWords('com', 'not_on_sale')).toBe(
      ".com isn't on sale, so there is no example price.",
    )
    expect(noExampleWords('com', 'no_price')).toBe(
      'No example price for .com: the site shows none until there is an active rate.',
    )
    expect(noExampleWords('com', 'unreadable')).toBe(
      "No example price: .com's catalogue row couldn't be read.",
    )
  })

  it('counts the catalogue in the words SQL counted', () => {
    expect(catalogueHints(status())).toEqual({
      tlds: '798 sellable, 3 paused by us, 6 featured',
      ssl: '3 on sale, 10 with a price from DomainNameAPI',
    })
  })

  it('hints each field with the bounds SQL holds it to', () => {
    expect(FIELD_HINT).toEqual({
      margin_ngn: '₦1,000 to ₦50,000 a domain, in whole naira.',
      fx_buffer_pct:
        '0% to 20%, at most two decimal places. Added to rates fetched after you save.',
      icann_fee_cents: '0 to 200 US cents a year: 20 is $0.20.',
      fx_move_threshold_pct: '1% to 50%, at most two decimal places.',
    })
  })
})

describe('the save dialog', () => {
  const current = settings()
  const active = rateRow()

  function effectOf(changes: Parameters<typeof settingsAfter>[1]) {
    return priceEffect(
      comSample(),
      pricingInputs(active, current),
      pricingInputs(active, settingsAfter(current, changes)),
    )
  }

  it('shows a margin change before and after, and what it does to .com and its renewal', () => {
    const changes = { margin_ngn: 5000 }
    expect(saveCopy({ changes, current, effect: effectOf(changes), activeBufferPct: 0 })).toEqual({
      title: 'Change 1 pricing setting?',
      rows: [
        { label: 'Margin', value: '₦4,250 → ₦5,000' },
        {
          label: 'Effect',
          value: '.com: ₦19,600 → ₦20,300 first year; renews at ₦19,900 → ₦20,600/yr',
        },
      ],
      body: [
        'Prices on the site change on the next refresh, within minutes. Orders already placed keep their prices.',
      ],
      confirmLabel: 'Save settings',
      cancelLabel: 'Cancel',
      success: 'Saved. Prices on the site update on the next refresh.',
    })
  })

  it('shows the ICANN fee’s effect on a generic extension', () => {
    const changes = { icann_fee_cents: 0 }
    const copy = saveCopy({ changes, current, effect: effectOf(changes), activeBufferPct: 0 })
    expect(copy.rows).toEqual([
      { label: 'ICANN fee', value: '$0.18 → $0.00' },
      {
        label: 'Effect',
        value: '.com: ₦19,600 → ₦19,300 first year; renews at ₦19,900 → ₦19,600/yr',
      },
    ])
  })

  it('says the buffer and the threshold change no price today, and shows no effect for them', () => {
    const changes = { fx_buffer_pct: 2, fx_move_threshold_pct: 10 }
    const copy = saveCopy({ changes, current, effect: effectOf(changes), activeBufferPct: 0 })
    expect(copy.title).toBe('Change 2 pricing settings?')
    expect(copy.rows).toEqual([
      { label: 'FX buffer', value: '1.5% → 2%' },
      { label: 'Move threshold', value: '6.5% → 10%' },
    ])
    expect(copy.body).toEqual([
      "The buffer is added to rates the FX job fetches from now on. The active rate keeps its own (0%), so it doesn't change today's prices.",
      'The FX job uses the new threshold from its next run: a fetched rate that moves further than this from the active one is held for review.',
    ])
    expect(copy.success).toBe('Saved.')
    expect(
      saveCopy({ changes: { fx_buffer_pct: 2 }, current, effect: null, activeBufferPct: null })
        .body,
    ).toEqual(['The buffer is added to rates the FX job fetches from now on.'])
  })

  it('leaves the effect out when there is no example to price', () => {
    const copy = saveCopy({
      changes: { margin_ngn: 5000 },
      current,
      effect: null,
      activeBufferPct: 0,
    })
    expect(copy.rows).toEqual([{ label: 'Margin', value: '₦4,250 → ₦5,000' }])
  })
})

describe('the activate and reject dialogs', () => {
  const active = { ...charged(rateRow()) }

  it('asks in the spec’s words for a rate with no buffer', () => {
    const rate = charged(freshRow())
    const effect = priceEffect(
      comSample(),
      pricingInputs(active, settings()),
      pricingInputs(rate, settings()),
    )
    const move = movePct(rate.costingRate, active.costingRate)
    expect(activateCopy({ rate, active, move, effect })).toEqual({
      title: 'Charge at ₦1,523.40 to the dollar?',
      rows: [
        {
          label: 'Current',
          value: `₦1,330.57 (quoted ${formatWat(active.quotedAt)}, since ${formatWat(active.effectiveFrom)})`,
        },
        { label: 'New', value: `₦1,523.40 (er-api, quoted ${formatWat(rate.quotedAt)})` },
        { label: 'Move', value: '+14.5%' },
        {
          label: 'Effect',
          value: '.com: ₦19,600 → ₦21,800 first year; renews at ₦19,900 → ₦22,100/yr',
        },
      ],
      body: 'Every price on the site changes on the next refresh, within minutes. Orders already placed keep their rate.',
      confirmLabel: 'Activate rate',
      cancelLabel: 'Not now',
      success: 'Activated. Prices on the site update on the next refresh.',
    })
  })

  it('charges a buffered rate at what it costs with its buffer, and shows the buffer change', () => {
    const rate = charged(staleRow())
    const effect = priceEffect(
      comSample(),
      pricingInputs(active, settings()),
      pricingInputs(rate, settings()),
    )
    const copy = activateCopy({ rate, active, move: movePct(1700, active.costingRate), effect })
    expect(copy.title).toBe('Charge at ₦1,768.00 to the dollar?')
    expect(copy.rows).toContainEqual({ label: 'Buffer', value: '0% → 4%' })
    expect(copy.rows).toContainEqual({ label: 'Move', value: '+27.8%' })
    expect(copy.rows).toContainEqual({
      label: 'Effect',
      value: '.com: ₦19,600 → ₦24,600 first year; renews at ₦19,900 → ₦25,000/yr',
    })
  })

  it('says there is no current rate, and prices the effect on the new one alone', () => {
    const rate = charged(freshRow())
    const effect = priceEffect(comSample(), null, pricingInputs(rate, settings()))
    const copy = activateCopy({ rate, active: null, move: null, effect })
    expect(copy.rows).toEqual([
      { label: 'Current', value: 'None — the site shows no prices' },
      { label: 'New', value: `₦1,523.40 (er-api, quoted ${formatWat(rate.quotedAt)})` },
      { label: 'Move', value: '—' },
      { label: 'Effect', value: '.com: ₦21,800 first year; renews at ₦22,100/yr (no price today)' },
    ])
  })

  it('rejects in words that say prices stay where they are', () => {
    const rate = staleRow()
    expect(rejectCopy({ rate, reviewReason: rate.reviewReason, active })).toEqual({
      title: 'Reject the ₦1,700.00 rate?',
      rows: [
        { label: 'Rate', value: `₦1,700.00 (er-api, quoted ${formatWat(rate.quotedAt)})` },
        { label: 'Held because', value: 'Moved 20.6% in one update, beyond the 5% threshold' },
      ],
      body: "Prices stay on the active rate, ₦1,330.57. The rejected rate stays in the history, marked rejected, and can't be activated from the dashboard.",
      confirmLabel: 'Reject rate',
      cancelLabel: 'Keep it held',
      success: 'Rejected. Prices are unchanged.',
    })
    expect(rejectCopy({ rate, reviewReason: null, active: null })).toMatchObject({
      rows: [expect.anything(), { label: 'Held because', value: '—' }],
      body: "The site keeps showing no prices until a rate is activated. The rejected rate stays in the history, marked rejected, and can't be activated from the dashboard.",
    })
  })

  it('words an effect with no price after it, and with none either way', () => {
    const today = termsAt(comSample(), pricingInputs(active, settings()))
    expect(effectLine({ tld: 'com', before: today, after: null })).toBe(
      '.com: no price after this (today ₦19,600 first year; renews at ₦19,900/yr)',
    )
    expect(effectLine({ tld: 'com', before: null, after: null })).toBe('.com: no price either way')
  })
})

describe('rates held for review', () => {
  it('says why Activate is not offered, in the spec’s and the wrapper’s words', () => {
    expect(TOO_OLD).toBe('Too old to activate — the daily job will fetch a fresh one.')
    expect(ADMIN_ERROR_WORDS.RATE_TOO_OLD).toBe(TOO_OLD)
    expect(BLOCK_DETAIL).toEqual({
      too_old: 'Quoted 48 hours ago or more.',
      older_than_active: 'Quoted before the active rate.',
    })
  })

  it('says how rates arrive, with the tolerance and the threshold interpolated', () => {
    expect(arrivalWords(2, 6.5)).toBe(
      'The FX job runs once a day. It cross-checks the market feeds it can reach and stops if they disagree by more than 2%. A rate within 6.5% of the active one is activated by the job; one that moves further, or arrives with no active rate, is held here for review.',
    )
    expect(arrivalWords(3, null)).toContain('more than 3%. A rate within the move threshold of')
    expect(noneHeldWords(6.5)).toBe(
      'No rate is held for review. The FX job holds one here when it moves more than 6.5% from the active rate, or when there is no active rate.',
    )
    expect(noneHeldWords(null)).toContain('more than the move threshold from')
  })
})
