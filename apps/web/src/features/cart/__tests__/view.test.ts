import { formatNaira, type PricingInputs, priceCatalogue, type TldRecord } from '@dr/shared'
import { describe, expect, it } from 'vitest'
import { priceLine, quoteFor } from '../lib/lines'
import { toLineView } from '../lib/view'

const INPUTS: PricingInputs = { fxRate: 1333.76, fxBufferPct: 0, marginNgn: 3000, icannFeeUsd: 0.2 }
const [net] = priceCatalogue(
  [
    {
      name: 'net',
      registerUsd: 13.99,
      renewUsd: 14.01,
      transferUsd: null,
      restoreUsd: null,
      isCountryCode: false,
      minPeriod: 1,
      maxPeriod: 3,
      redemptionDays: 30,
      requiresExtraFields: false,
    } satisfies TldRecord,
  ],
  INPUTS,
)
if (!net) throw new Error('fixture')

const quote = quoteFor(net, 1)
const stored = {
  id: 'line-1',
  domain: 'getpaid.net',
  tld: 'net',
  periodYears: 1,
  privacy: true,
  autoRenew: true,
  quotedTotalKobo: quote.totalKobo,
  quotedRenewalKobo: quote.renewalKobo,
  quotedAt: '2026-09-23T10:00:00.000Z',
}

describe('toLineView', () => {
  const view = toLineView(priceLine(stored, net, new Date('2026-09-23T10:05:00Z'), 30), net)

  it('sends display strings, never kobo, cost or margin, to the browser', () => {
    for (const key of Object.keys(view)) expect(key).not.toMatch(/kobo|cost|margin/i)
    expect(view.total).toMatch(/^₦[\d,]+$/)
  })

  it('offers every period the registry allows, each with its total', () => {
    expect(view.periodOptions.map((option) => option.years)).toEqual([1, 2, 3])
    expect(view.periodOptions[1]?.label).toMatch(/^2 years — ₦[\d,]+$/)
  })

  it('shows when the price hold ends, in Lagos time', () => {
    expect(view.heldUntil).toBe('11:30 am')
  })
})

describe('toLineView — lines whose quote no longer stands', () => {
  const later = new Date('2026-09-23T11:00:00Z')

  it('shows the old price beside the new one when the price moved (FR-C4)', () => {
    const changed = toLineView(
      priceLine({ ...stored, quotedTotalKobo: 1_000_000 }, net, later, 30),
      net,
    )
    expect(changed.status).toBe('changed')
    expect(changed.was).toBe(formatNaira(1_000_000))
    expect(changed.total).toBe(formatNaira(quote.totalKobo))
    expect(changed.heldUntil).toBeNull()
  })

  it('shows no old price when the price is unchanged', () => {
    const current = toLineView(priceLine(stored, net, later, 30), net)
    expect(current.status).toBe('current')
    expect(current.was).toBeNull()
  })

  it('offers only the period already chosen for an extension we stopped selling', () => {
    const gone = toLineView(
      priceLine({ ...stored, periodYears: 2 }, undefined, later, 30),
      undefined,
    )
    expect(gone.status).toBe('unavailable')
    expect(gone.periodOptions).toEqual([{ years: 2, label: '2 years' }])
    expect(gone.privacyOffered).toBe(false)
    expect(gone.includesIcannFee).toBe(false)
  })

  it('says “1 year”, not “1 years”', () => {
    expect(toLineView(priceLine(stored, net, later, 30), net).periodOptions[0]?.label).toMatch(
      /^1 year — /,
    )
    expect(
      toLineView(priceLine(stored, undefined, later, 30), undefined).periodOptions[0]?.label,
    ).toBe('1 year')
  })
})
