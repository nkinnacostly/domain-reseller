import { describe, expect, it } from 'vitest'
import {
  FEES_NOTE,
  itemLabel,
  MARGIN_COLUMNS,
  marginCaption,
  REVENUE_COLUMNS,
  revenueNote,
  SOURCE_LABEL,
  sideName,
  sideWord,
} from '@/features/admin/lib/money-copy'

describe('the margin caption (§5.2, N9b)', () => {
  it('is the spec’s words, with the count of lines left out', () => {
    expect(marginCaption(3)).toBe(
      "Margin is shown at the rate we charged, and only for lines whose cost is known — matched to DomainNameAPI's ledger, or recorded at checkout. 3 lines sold before costs were recorded are left out.",
    )
  })

  it('counts one line as one, and thousands with separators', () => {
    expect(marginCaption(1)).toMatch(/ 1 line sold before costs were recorded is left out\.$/)
    expect(marginCaption(1200)).toMatch(
      / 1,200 lines sold before costs were recorded are left out\.$/,
    )
  })

  it('says nothing about lines left out when none are', () => {
    expect(marginCaption(0)).toBe(
      "Margin is shown at the rate we charged, and only for lines whose cost is known — matched to DomainNameAPI's ledger, or recorded at checkout.",
    )
  })

  it('names where each cost came from, and never claims an estimate', () => {
    expect(SOURCE_LABEL).toEqual({
      ledger: "DomainNameAPI's ledger",
      checkout: 'Recorded at checkout',
      none: 'Not costed',
    })
    expect(MARGIN_COLUMNS.cost).toBe('Cost (at the rate charged)')
    expect(MARGIN_COLUMNS.revenue).toBe('Revenue (VAT excluded)')
  })
})

describe('line refunds and charge refunds (§6)', () => {
  it('are separate columns, each saying where VAT stands', () => {
    expect(REVENUE_COLUMNS.lineRefund).toBe('Line refunds (VAT excluded)')
    expect(REVENUE_COLUMNS.lineRefundVat).toBe('VAT returned with them')
    expect(REVENUE_COLUMNS.chargeRefund).toBe('Charge refunds (no VAT)')
  })

  it('every sales and cash column says whether VAT is in it', () => {
    expect(REVENUE_COLUMNS.net).toMatch(/VAT excluded/)
    expect(REVENUE_COLUMNS.cash).toMatch(/VAT included/)
    expect(REVENUE_COLUMNS.vat).toBe('VAT collected')
  })
})

describe('the rest of the words', () => {
  it('names the side every figure is from', () => {
    expect(sideWord('live')).toBe('Live')
    expect(sideWord('test')).toBe('Test')
    expect(sideName('test')).toBe('the test side')
  })

  it('names items, and shows an unknown one as itself', () => {
    expect(itemLabel('transfer')).toBe('Transfers in')
    expect(itemLabel('gift_card')).toBe('gift card')
  })

  it('says how the table is cut at each grain', () => {
    expect(revenueNote('day')).toMatch(/^Days with no sales, payments or refunds are left out/)
    expect(revenueNote('week')).toMatch(/Weeks start on Monday/)
    expect(revenueNote('month')).toMatch(/A month cut by your dates/)
    expect(FEES_NOTE).toMatch(/as Flutterwave reported them/)
  })
})
