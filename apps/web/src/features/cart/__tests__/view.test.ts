import { type PricingInputs, priceCatalogue, type TldRecord } from '@dr/shared'
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
