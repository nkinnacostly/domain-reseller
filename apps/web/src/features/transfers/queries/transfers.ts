import 'server-only'

import type { LocalStatus } from '@dr/shared'
import { createClient } from '@/lib/supabase/server'

/** One transfer in, as its owner may see it — read under RLS (migration 12). */
export type TransferRow = {
  id: string
  domainName: string
  status: LocalStatus
  testMode: boolean
  startedAt: string
  /** When the registry accepted the request, from the domain's activity. */
  submittedAt: string | null
  orderId: string | null
  orderNumber: string | null
}

/** Every domain the account brought in by transfer, newest first. */
export async function getTransfers(): Promise<TransferRow[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('domains')
    .select(
      'id, domain_name, local_status, test_mode, created_at, order_items(order_id, orders(order_number)), domain_events(event_type, created_at)',
    )
    .eq('source', 'transfer')
    .eq('domain_events.event_type', 'transfer_submitted')
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) throw new Error(`transfers: ${error.message}`)

  return (data ?? []).map((row) => ({
    id: row.id,
    domainName: row.domain_name,
    status: row.local_status as LocalStatus,
    testMode: row.test_mode,
    startedAt: row.created_at,
    submittedAt: row.domain_events?.[0]?.created_at ?? null,
    orderId: row.order_items?.order_id ?? null,
    orderNumber: row.order_items?.orders?.order_number ?? null,
  }))
}
