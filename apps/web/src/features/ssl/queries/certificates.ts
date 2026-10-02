import 'server-only'

import type { Database } from '@dr/db/types'
import { createClient } from '@/lib/supabase/server'

/**
 * Certificates read as their owner — RLS returns only your own (migration
 * 39). Nothing here writes: every change is a service-role function.
 */

export type CertificateRow = Database['public']['Tables']['ssl_certificates']['Row']

/** Without the certificate text and contact: what a list needs. */
const LIST_COLUMNS =
  'id, order_item_id, product_code, product_name, is_wildcard, included_names, common_name, test_mode, status, purchased_at, subscription_ends_at, issued_at, expires_at, last_error_code, created_at'

export type CertificateSummary = Pick<
  CertificateRow,
  | 'id'
  | 'order_item_id'
  | 'product_code'
  | 'product_name'
  | 'is_wildcard'
  | 'included_names'
  | 'common_name'
  | 'test_mode'
  | 'status'
  | 'purchased_at'
  | 'subscription_ends_at'
  | 'issued_at'
  | 'expires_at'
  | 'last_error_code'
  | 'created_at'
>

/** Null when it could not be read: the page says so, it never shows an empty list instead. */
export async function listMyCertificates(): Promise<CertificateSummary[] | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('ssl_certificates')
    .select(LIST_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) return null
  return data ?? []
}

export async function getMyCertificate(id: string): Promise<CertificateRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const supabase = await createClient()
  const { data } = await supabase.from('ssl_certificates').select('*').eq('id', id).maybeSingle()
  return data ?? null
}

/** An order's certificates, by its line: the order page links each line to its certificate. */
export async function getOrderCertificates(
  orderItemIds: readonly string[],
): Promise<Map<string, Pick<CertificateRow, 'id' | 'product_name' | 'status'>>> {
  if (orderItemIds.length === 0) return new Map()
  const supabase = await createClient()
  const { data } = await supabase
    .from('ssl_certificates')
    .select('id, order_item_id, product_name, status')
    .in('order_item_id', [...orderItemIds])
  return new Map((data ?? []).map((row) => [row.order_item_id, row]))
}
