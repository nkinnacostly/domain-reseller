import 'server-only'

import { cache } from 'react'
import { type Overview, parseOverview } from '@/features/admin/lib/overview-data'
import type { AdminSide } from '@/features/admin/lib/side'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'
import { type AdminPrincipal, adminDb } from './session'

/**
 * The overview's reads (docs/ADMIN-SPEC.md §5.2 B1, D4). Health, sales, the
 * float and the charts are one SQL read, `admin_overview`, called as the
 * admin: it checks who is asking and refuses a test administrator the live
 * side itself. The latest orders are a row list through `adminDb`, which
 * applies the side and reads orders only through `admin_orders_v`.
 */

/** Everything but the lists for one side, once per request; null when it could not be read. */
export const getOverview = cache(async (side: AdminSide): Promise<Overview | null> => {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('admin_overview', { p_test_mode: side === 'test' })
  if (error) {
    logger.warn({ code: error.code }, 'admin overview unavailable')
    return null
  }
  const parsed = parseOverview(data)
  if ('issues' in parsed) {
    logger.error({ issues: parsed.issues }, 'admin_overview answered an unexpected shape')
    return null
  }
  return parsed.overview
})

export type RecentOrder = {
  id: string
  orderNumber: string
  status: string
  totalKobo: number
  paidAt: string
  invoiceNumber: string | null
  testMode: boolean
}

export const RECENT_ORDERS = 10

/** The latest paid orders on the side, newest first; null when they could not be read. */
export async function getRecentPaidOrders(
  admin: AdminPrincipal,
  side: AdminSide,
): Promise<RecentOrder[] | null> {
  try {
    const { data, error } = await adminDb(admin, side)
      .from('admin_orders_v')
      .select('id, order_number, status, total_kobo, paid_at, invoice_number, test_mode')
      .not('payment_id', 'is', null)
      .order('paid_at', { ascending: false })
      .limit(RECENT_ORDERS)
    if (error) {
      logger.warn({ code: error.code }, 'admin recent orders unavailable')
      return null
    }
    return (data ?? []).flatMap((row) =>
      row.id && row.order_number && row.paid_at && Number.isSafeInteger(row.total_kobo)
        ? [
            {
              id: row.id,
              orderNumber: row.order_number,
              status: row.status ?? 'paid',
              totalKobo: row.total_kobo as number,
              paidAt: row.paid_at,
              invoiceNumber: row.invoice_number,
              testMode: row.test_mode === true,
            },
          ]
        : [],
    )
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.name : 'unknown' },
      'admin recent orders refused',
    )
    return null
  }
}
