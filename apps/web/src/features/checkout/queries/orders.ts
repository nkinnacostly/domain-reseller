import 'server-only'

import { createClient } from '@/lib/supabase/server'

/** Orders read as the user — RLS returns only their own (migration 11). */

export async function getOrders() {
  const supabase = await createClient()
  const { data } = await supabase
    .from('orders')
    .select(
      'id, order_number, status, total_kobo, test_mode, created_at, invoice_number, order_items(domain, item_type)',
    )
    .order('created_at', { ascending: false })
    .limit(50)
  return data ?? []
}

export async function getOrder(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const supabase = await createClient()
  const { data } = await supabase
    .from('orders')
    .select(
      'id, user_id, order_number, status, subtotal_kobo, vat_pct, vat_kobo, total_kobo, registrant, nameservers, test_mode, float_check, paid_at, created_at, order_items(id, item_type, domain, period_years, privacy, auto_renew, price_kobo, renewal_kobo, status, failure_code, nameservers), payments(provider_reference, amount_kobo, method, created_at)',
    )
    .eq('id', id)
    .maybeSingle()
  return data
}

export type OrderRefund = {
  id: string
  domain: string | null
  reason: string
  amountKobo: number
  state: 'processing' | 'sent' | 'refunded'
  refundedAt: string | null
  testMode: boolean
}

/**
 * The refunds on one order, as its owner may see them (migration 15): the
 * database function checks ownership and leaves internal detail out.
 */
export async function getOrderRefunds(orderId: string): Promise<OrderRefund[]> {
  const supabase = await createClient()
  const { data } = await supabase.rpc('my_order_refunds', { p_order_id: orderId })
  return (data ?? []).map((row) => ({
    id: row.id,
    domain: row.domain,
    reason: row.reason,
    amountKobo: Number(row.amount_kobo),
    state: row.state as OrderRefund['state'],
    refundedAt: row.refunded_at,
    testMode: row.test_mode,
  }))
}
