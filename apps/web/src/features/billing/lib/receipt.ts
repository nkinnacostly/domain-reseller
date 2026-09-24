/**
 * The receipt for a paid order (CMP-17, FR-C5, N8). Built only from what the
 * order recorded when it was placed and paid — its lines, prices, VAT rate,
 * registrant and payment — so it reads the same every time it is opened.
 * Pure: no I/O, so every rule here is tested directly.
 */

export type LineKind = 'register' | 'renew' | 'transfer'

export type ReceiptLine = {
  id: string
  domain: string
  kind: LineKind
  years: number
  priceKobo: number
  /** N8 — the renewal price quoted with the line, shown beside its price. */
  renewalKobo: number
  failed: boolean
}

export type ReceiptCustomer = {
  name: string | null
  company: string | null
  email: string | null
  /** Street, then town and postcode, then country — empty parts left out. */
  address: string[]
}

export type ReceiptPayment = {
  /** Our reference for the charge (the Flutterwave `tx_ref`). */
  reference: string
  /** Flutterwave's own transaction id, when a charge was recorded. */
  transactionId: string | null
  method: string
  amountKobo: number | null
}

export type Receipt = {
  orderId: string
  orderNumber: string
  invoiceNumber: string
  paidAt: string
  testMode: boolean
  customer: ReceiptCustomer
  lines: ReceiptLine[]
  subtotalKobo: number
  vatPct: number
  vatKobo: number
  totalKobo: number
  payment: ReceiptPayment
}

/** The order as the receipt query reads it (RLS: the owner's own). */
export type ReceiptRow = {
  id: string
  order_number: string
  invoice_number: string | null
  paid_at: string | null
  payment_id: string | null
  tx_ref: string
  subtotal_kobo: number | string
  vat_pct: number | string
  vat_kobo: number | string
  total_kobo: number | string
  registrant: unknown
  test_mode: boolean
  order_items: {
    id: string
    item_type: string
    domain: string
    period_years: number
    price_kobo: number | string
    renewal_kobo: number | string
    status: string
    created_at: string
  }[]
  payments: {
    id: string
    provider_reference: string
    amount_kobo: number | string
    method: string | null
    created_at: string
  }[]
}

const KINDS: Record<string, LineKind> = {
  register: 'register',
  renew: 'renew',
  transfer: 'transfer',
}

const KIND_LABEL: Record<LineKind, string> = {
  register: 'Registration',
  renew: 'Renewal',
  transfer: 'Transfer',
}

const NOT_DONE: Record<LineKind, string> = {
  register: 'Not registered',
  renew: 'Not renewed',
  transfer: 'Not transferred',
}

/** "Registration, 2 years" — what the line bought. */
export function lineLabel(kind: LineKind, years: number): string {
  return `${KIND_LABEL[kind]}, ${years} ${years === 1 ? 'year' : 'years'}`
}

/** FR-R2 — a line that failed says so on the receipt; its refund is listed below. */
export function notDoneLabel(kind: LineKind): string {
  return NOT_DONE[kind]
}

/** Flutterwave's `payment_type`, in words. Anything unknown is still Flutterwave. */
const METHODS: Record<string, string> = {
  card: 'Card',
  bank_transfer: 'Bank transfer',
  banktransfer: 'Bank transfer',
  account: 'Bank account',
  ussd: 'USSD',
}

export function paymentMethodLabel(method: string | null | undefined): string {
  const known = method ? METHODS[method.toLowerCase()] : undefined
  return known ? `${known}, through Flutterwave` : 'Flutterwave'
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

/**
 * The customer block, from the registrant recorded on the order. A renewal
 * copies the domain's registrant, which can be empty — then only what is
 * there is shown, never a guess.
 */
export function receiptCustomer(
  registrant: unknown,
  countryName: (code: string) => string = (code) => code,
): ReceiptCustomer {
  const contact = (registrant && typeof registrant === 'object' ? registrant : {}) as Record<
    string,
    unknown
  >
  const present = (parts: (string | null)[]) =>
    parts.filter((part): part is string => part !== null)
  const name = present([text(contact.firstName), text(contact.lastName)]).join(' ')
  const street = present([text(contact.addressLine1), text(contact.addressLine2)])
  const town = present([text(contact.city), text(contact.state), text(contact.zipCode)]).join(', ')
  const country = text(contact.country)
  return {
    name: name || null,
    company: text(contact.company),
    email: text(contact.email),
    address: [...street, ...(town ? [town] : []), ...(country ? [countryName(country)] : [])],
  }
}

/**
 * The receipt, or null when the order has none: only a paid order has an
 * invoice number, taken with its payment in one transaction (migration 26).
 */
export function toReceipt(row: ReceiptRow, countryName?: (code: string) => string): Receipt | null {
  if (!row.invoice_number || !row.paid_at) return null

  // The charge that paid the order; a second charge on it is refunded, not receipted.
  const paying =
    row.payments.find((payment) => payment.id === row.payment_id) ??
    [...row.payments].sort((a, b) => a.created_at.localeCompare(b.created_at))[0]

  const lines = [...row.order_items]
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    .map(
      (item): ReceiptLine => ({
        id: item.id,
        domain: item.domain,
        kind: KINDS[item.item_type] ?? 'register',
        years: item.period_years,
        priceKobo: Number(item.price_kobo),
        renewalKobo: Number(item.renewal_kobo),
        failed: item.status === 'failed',
      }),
    )

  return {
    orderId: row.id,
    orderNumber: row.order_number,
    invoiceNumber: row.invoice_number,
    paidAt: row.paid_at,
    testMode: row.test_mode,
    customer: receiptCustomer(row.registrant, countryName),
    lines,
    subtotalKobo: Number(row.subtotal_kobo),
    vatPct: Number(row.vat_pct),
    vatKobo: Number(row.vat_kobo),
    totalKobo: Number(row.total_kobo),
    payment: {
      reference: row.tx_ref,
      transactionId: paying?.provider_reference ?? null,
      method: paymentMethodLabel(paying?.method),
      amountKobo: paying ? Number(paying.amount_kobo) : null,
    },
  }
}

const DATE = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'Africa/Lagos' })

/** A receipt's dates are Lagos dates: a payment at 23:30 UTC was made the next day here. */
export function receiptDate(iso: string): string {
  return DATE.format(new Date(iso))
}
