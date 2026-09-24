import 'server-only'

import { getOrderRefunds, type OrderRefund } from '@/features/checkout/queries/orders'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'
import { type Receipt, type ReceiptRow, toReceipt } from '../lib/receipt'

export type ReceiptLookup =
  /** Not an order, or not this person's: RLS returns nothing either way. */
  | { state: 'missing' }
  /** The order could not be read just now. */
  | { state: 'error' }
  /** An order that was never paid has no receipt. */
  | { state: 'unpaid'; orderId: string; orderNumber: string }
  | { state: 'ready'; receipt: Receipt; refunds: OrderRefund[] }

const COLUMNS =
  'id, order_number, invoice_number, paid_at, payment_id, tx_ref, subtotal_kobo, vat_pct, vat_kobo, total_kobo, registrant, test_mode, order_items(id, item_type, domain, period_years, price_kobo, renewal_kobo, status, created_at), payments(id, provider_reference, amount_kobo, method, created_at)'

const regions = new Intl.DisplayNames(['en'], { type: 'region' })
const countryName = (code: string) => {
  try {
    return regions.of(code) ?? code
  } catch {
    return code
  }
}

/**
 * One order's receipt, read as its owner (RLS, migration 11) — the same way
 * the order page reads it. Refunds come from `my_order_refunds`, which checks
 * ownership itself and leaves internal detail out.
 */
export async function getReceipt(id: string): Promise<ReceiptLookup> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { state: 'missing' }
  const supabase = await createClient()
  const [{ data, error }, refunds] = await Promise.all([
    supabase.from('orders').select(COLUMNS).eq('id', id).maybeSingle(),
    getOrderRefunds(id),
  ])
  if (error) {
    logger.error({ code: error.code, err: error.message, orderId: id }, 'receipt read failed')
    return { state: 'error' }
  }
  if (!data) return { state: 'missing' }

  const receipt = toReceipt(data as ReceiptRow, countryName)
  if (!receipt) return { state: 'unpaid', orderId: data.id, orderNumber: data.order_number }
  return { state: 'ready', receipt, refunds }
}
