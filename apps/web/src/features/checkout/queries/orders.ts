import 'server-only'

import { createClient } from '@/lib/supabase/server'

/** Orders read as the user — RLS returns only their own (migration 11). */

export async function getOrders() {
  const supabase = await createClient()
  const { data } = await supabase
    .from('orders')
    .select('id, order_number, status, total_kobo, test_mode, created_at, order_items(domain)')
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
      'id, order_number, status, subtotal_kobo, vat_pct, vat_kobo, total_kobo, registrant, nameservers, test_mode, float_check, paid_at, created_at, order_items(id, domain, period_years, privacy, auto_renew, price_kobo, renewal_kobo, status), payments(provider_reference, amount_kobo, method, created_at)',
    )
    .eq('id', id)
    .maybeSingle()
  return data
}
