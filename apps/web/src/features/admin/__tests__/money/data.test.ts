import { describe, expect, it } from 'vitest'
import {
  hasActivity,
  marginSummary,
  parseMargin,
  parseRevenue,
  revenueTotals,
} from '@/features/admin/lib/money-data'
import { marginAnswer, marginRow, revenueAnswer, revenueRow } from './fixtures'

describe('admin_revenue, as the page reads it', () => {
  it('refuses a figure that is not whole kobo, rather than show a wrong number (N5)', () => {
    expect(parseRevenue([revenueRow('2026-10-01', { net_kobo: 10.5 })])).toEqual({ issues: 1 })
    expect(parseRevenue([{ ...revenueRow('2026-10-01'), bucket: 'Oct 1' }])).toEqual({ issues: 1 })
    expect(parseRevenue({ rows: [] })).toEqual({ issues: 1 })
  })

  it('keeps line refunds and charge refunds apart, with the VAT returned beside line refunds', () => {
    const parsed = parseRevenue(revenueAnswer())
    if ('issues' in parsed) throw new Error('unparsed')
    const last = parsed.rows[2]
    expect(last).toEqual({
      bucket: '2026-10-03',
      orders: 1,
      netKobo: 1_000_000,
      vatKobo: 75_000,
      cashKobo: 2_150_000,
      lineRefundKobo: 1_000_000,
      lineRefundVatKobo: 75_000,
      chargeRefundKobo: 1_075_000,
      feeKobo: 15_050,
      feeAbsorbedKobo: 0,
    })
  })

  it('adds every bucket up, and knows an empty one', () => {
    const parsed = parseRevenue(revenueAnswer())
    if ('issues' in parsed) throw new Error('unparsed')
    const totals = revenueTotals(parsed.rows)
    expect(totals).toEqual({
      orders: 3,
      netKobo: 3_000_000,
      vatKobo: 225_000,
      cashKobo: 4_300_000,
      lineRefundKobo: 1_000_000,
      lineRefundVatKobo: 75_000,
      chargeRefundKobo: 1_075_000,
      feeKobo: 45_150,
      feeAbsorbedKobo: 30_100,
    })
    expect(hasActivity(totals)).toBe(true)
    expect(parsed.rows.map(hasActivity)).toEqual([true, false, true])
    expect(hasActivity(revenueTotals([]))).toBe(false)
  })
})

describe('admin_margin, as the page reads it', () => {
  it('refuses a group it does not know, or a cost that is not whole kobo', () => {
    expect(parseMargin([marginRow({ cost_source: 'guess' as never })])).toEqual({ issues: 1 })
    expect(parseMargin([marginRow({ cost_kobo: 1.25 })])).toEqual({ issues: 1 })
    expect(parseMargin([marginRow({ row_kind: 'estimated' as never })])).toEqual({ issues: 1 })
  })

  it('sums months by item and source, in a fixed order', () => {
    const summary = marginSummary(marginAnswer())
    expect(summary.sold.map((line) => line.key)).toEqual([
      'register:ledger',
      'register:none',
      'renew:checkout',
    ])
    expect(summary.sold[0]).toMatchObject({
      lines: 3,
      costedLines: 3,
      revenueKobo: 6_000_000,
      costKobo: 5_100_000,
      marginKobo: 900_000,
    })
  })

  it('keeps an uncosted line out of the margin: its revenue on its row, its cost not known (D13)', () => {
    const summary = marginSummary(marginAnswer())
    expect(summary.sold[1]).toMatchObject({
      source: 'none',
      lines: 2,
      costedLines: 0,
      revenueKobo: 3_800_000,
      costKobo: null,
      marginKobo: null,
    })
    expect(summary.uncostedLines).toBe(2)
  })

  it('puts every failed or refunded line the supplier charged for in one lost row', () => {
    const summary = marginSummary([
      ...marginAnswer(),
      marginRow({
        row_kind: 'lost',
        item_type: 'ssl',
        month: '2026-09-01',
        revenue_kobo: 0,
        cost_kobo: 900_000,
        margin_kobo: -900_000,
      }),
    ])
    expect(summary.lost).toMatchObject({
      key: 'lost',
      itemType: null,
      source: 'ledger',
      lines: 2,
      costedLines: 2,
      revenueKobo: 0,
      costKobo: 2_600_000,
      marginKobo: -2_600_000,
    })
  })

  it('totals only lines whose cost is known, after what was lost', () => {
    const { total } = marginSummary(marginAnswer())
    // Registrations on the ledger and the renewal at checkout, then the lost line.
    expect(total).toEqual({
      lines: 5,
      costedLines: 5,
      revenueKobo: 7_900_000,
      costKobo: 8_450_000,
      marginKobo: -550_000,
      costTopupKobo: null,
    })
    expect(total.revenueKobo - (total.costKobo ?? 0)).toBe(total.marginKobo)
  })

  it('always has a lost row, at nothing when the supplier charged for no failed line', () => {
    const summary = marginSummary([marginRow()])
    expect(summary.lost).toMatchObject({ lines: 0, costKobo: 0, marginKobo: 0 })
    expect(summary.empty).toBe(false)
    expect(marginSummary([]).empty).toBe(true)
  })

  it('offers the top-up column only when SQL priced a cost at a recorded top-up (live only)', () => {
    expect(marginSummary(marginAnswer()).hasTopupCost).toBe(false)
    const summary = marginSummary([
      marginRow({ cost_topup_kobo: 1_800_000 }),
      marginRow({ item_type: 'renew', cost_topup_kobo: 1_750_000 }),
      marginRow({ cost_source: 'none', cost_kobo: null, margin_kobo: null, costed_lines: 0 }),
    ])
    expect(summary.hasTopupCost).toBe(true)
    expect(summary.sold.find((line) => line.source === 'none')?.costTopupKobo).toBeNull()
    expect(summary.total.costTopupKobo).toBe(3_550_000)
  })
})
