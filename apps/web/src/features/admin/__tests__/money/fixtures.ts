/** 3 Oct 2026, 10:00 WAT (09:00 UTC). */
export const NOW = new Date('2026-10-03T09:00:00Z')

/** One bucket as `admin_revenue` answers it: snake_case, integer kobo. */
export function revenueRow(bucket: string, overrides: Record<string, number> = {}) {
  return {
    bucket,
    orders: 0,
    net_kobo: 0,
    vat_kobo: 0,
    cash_kobo: 0,
    line_refunded_kobo: 0,
    line_refunded_vat_kobo: 0,
    charge_refunded_kobo: 0,
    fee_kobo: 0,
    fee_absorbed_kobo: 0,
    ...overrides,
  }
}

/** Three days: a sale with a fee we absorbed, nothing, then a line refund and a charge refund. */
export function revenueAnswer() {
  return [
    revenueRow('2026-10-01', {
      orders: 2,
      net_kobo: 2_000_000,
      vat_kobo: 150_000,
      cash_kobo: 2_150_000,
      fee_kobo: 30_100,
      fee_absorbed_kobo: 30_100,
    }),
    revenueRow('2026-10-02'),
    revenueRow('2026-10-03', {
      orders: 1,
      net_kobo: 1_000_000,
      vat_kobo: 75_000,
      cash_kobo: 2_150_000,
      line_refunded_kobo: 1_000_000,
      line_refunded_vat_kobo: 75_000,
      charge_refunded_kobo: 1_075_000,
      fee_kobo: 15_050,
    }),
  ]
}

type MarginOverrides = Partial<{
  month: string
  row_kind: 'sold' | 'lost'
  item_type: string
  lines: number
  costed_lines: number
  revenue_kobo: number
  cost_kobo: number | null
  margin_kobo: number | null
  cost_topup_kobo: number | null
  cost_source: 'ledger' | 'checkout' | 'none'
}>

/** One group as `admin_margin` answers it. */
export function marginRow(overrides: MarginOverrides = {}) {
  return {
    month: '2026-10-01',
    row_kind: 'sold' as const,
    item_type: 'register',
    lines: 1,
    costed_lines: 1,
    revenue_kobo: 2_000_000,
    cost_kobo: 1_700_000,
    margin_kobo: 300_000,
    cost_topup_kobo: null,
    cost_source: 'ledger' as const,
    ...overrides,
  }
}

/**
 * Two months of registrations matched to the ledger, one renewal costed at
 * checkout, two registrations sold before costs were recorded, and one
 * failed registration the supplier charged for.
 */
export function marginAnswer() {
  return [
    marginRow({ month: '2026-09-01' }),
    marginRow({
      month: '2026-10-01',
      lines: 2,
      costed_lines: 2,
      revenue_kobo: 4_000_000,
      cost_kobo: 3_400_000,
      margin_kobo: 600_000,
    }),
    marginRow({
      item_type: 'renew',
      cost_source: 'checkout',
      revenue_kobo: 1_900_000,
      cost_kobo: 1_650_000,
      margin_kobo: 250_000,
    }),
    marginRow({
      month: '2026-09-01',
      lines: 2,
      costed_lines: 0,
      revenue_kobo: 3_800_000,
      cost_kobo: null,
      margin_kobo: null,
      cost_source: 'none',
    }),
    marginRow({
      row_kind: 'lost',
      revenue_kobo: 0,
      cost_kobo: 1_700_000,
      margin_kobo: -1_700_000,
    }),
  ]
}
