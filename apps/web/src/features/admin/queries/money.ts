import 'server-only'

import {
  type MarginGroup,
  parseMargin,
  parseRevenue,
  type RevenueBucket,
} from '@/features/admin/lib/money-data'
import type { MoneyParams } from '@/features/admin/lib/money-params'
import type { AdminSide } from '@/features/admin/lib/side'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'

/**
 * The Money page's reads (docs/ADMIN-SPEC.md §5.2 B7, §6, D4). Both are SQL
 * aggregates — `admin_revenue` and `admin_margin` — called as the admin with
 * the session client: each checks who is asking, refuses a test
 * administrator the live side, and sums payments and line costs in SQL, so
 * no row of either reaches the page. Money comes back in integer kobo.
 */

/** Sales, VAT, cash, refunds and fees per bucket; null when it could not be read. */
export async function getRevenue(
  side: AdminSide,
  params: Pick<MoneyParams, 'from' | 'to' | 'grain'>,
): Promise<RevenueBucket[] | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('admin_revenue', {
    p_test_mode: side === 'test',
    p_grain: params.grain,
    p_from: params.from,
    p_to: params.to,
  })
  if (error) {
    logger.warn({ code: error.code }, 'admin revenue unavailable')
    return null
  }
  const parsed = parseRevenue(data)
  if ('issues' in parsed) {
    logger.error({ issues: parsed.issues }, 'admin_revenue answered an unexpected shape')
    return null
  }
  return parsed.rows
}

/** Margin groups by month, sold or lost, item type and cost source; null when it could not be read. */
export async function getMargin(
  side: AdminSide,
  params: Pick<MoneyParams, 'from' | 'to'>,
): Promise<MarginGroup[] | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('admin_margin', {
    p_test_mode: side === 'test',
    p_from: params.from,
    p_to: params.to,
  })
  if (error) {
    logger.warn({ code: error.code }, 'admin margin unavailable')
    return null
  }
  const parsed = parseMargin(data)
  if ('issues' in parsed) {
    logger.error({ issues: parsed.issues }, 'admin_margin answered an unexpected shape')
    return null
  }
  return parsed.rows
}
