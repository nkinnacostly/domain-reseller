/**
 * Tax invoices as `mail.invoices` keeps them (migration 50): numbered
 * MDM-INV-… for live payments and MDM-TEST-INV-… for test ones, with the
 * buyer, the lines and the sums as issued. The seller's facts (CAC, TIN)
 * come from `BUSINESS` when the page prints them.
 */

export type InvoiceLine = { description: string; amountKobo: number }

export type Invoice = {
  id: string
  number: string
  testMode: boolean
  issuedAt: string
  billedTo: { name: string; website: string | null }
  planName: string
  periodStart: string
  periodEnd: string
  lines: InvoiceLine[]
  subtotalKobo: number
  vatBps: number
  vatKobo: number
  totalKobo: number
  paidKobo: number
  providerReference: string
  txRef: string
  method: string | null
}

export type InvoiceSummary = Pick<
  Invoice,
  'id' | 'number' | 'testMode' | 'issuedAt' | 'planName' | 'periodStart' | 'periodEnd' | 'totalKobo'
>

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const whole = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value)
const str = (value: unknown): value is string => typeof value === 'string'

function readLines(value: unknown): InvoiceLine[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const lines = value.map((line) =>
    isObject(line) && str(line.description) && whole(line.amountKobo)
      ? { description: line.description, amountKobo: Number(line.amountKobo) }
      : null,
  )
  return lines.some((line) => line === null) ? null : (lines as InvoiceLine[])
}

export function readInvoiceSummary(row: unknown): InvoiceSummary | null {
  if (!isObject(row)) return null
  const { id, number, test_mode, issued_at, plan_name, period_start, period_end, total_kobo } = row
  if (
    !str(id) ||
    !str(number) ||
    typeof test_mode !== 'boolean' ||
    !str(issued_at) ||
    !str(plan_name) ||
    !str(period_start) ||
    !str(period_end) ||
    !whole(total_kobo)
  ) {
    return null
  }
  return {
    id,
    number,
    testMode: test_mode,
    issuedAt: issued_at,
    planName: plan_name,
    periodStart: period_start,
    periodEnd: period_end,
    totalKobo: Number(total_kobo),
  }
}

export function readInvoice(row: unknown): Invoice | null {
  const summary = readInvoiceSummary(row)
  if (!summary || !isObject(row)) return null
  const lines = readLines(row.lines)
  const billedTo = isObject(row.billed_to) ? row.billed_to : null
  const sums = [row.subtotal_kobo, row.vat_bps, row.vat_kobo, row.paid_kobo]
  if (!lines || !billedTo || !str(billedTo.name) || !sums.every(whole)) return null
  if (!str(row.provider_reference) || !str(row.tx_ref)) return null
  return {
    ...summary,
    billedTo: { name: billedTo.name, website: str(billedTo.website) ? billedTo.website : null },
    lines,
    subtotalKobo: Number(row.subtotal_kobo),
    vatBps: Number(row.vat_bps),
    vatKobo: Number(row.vat_kobo),
    paidKobo: Number(row.paid_kobo),
    providerReference: row.provider_reference,
    txRef: row.tx_ref,
    method: str(row.method) && row.method.length > 0 ? row.method : null,
  }
}
