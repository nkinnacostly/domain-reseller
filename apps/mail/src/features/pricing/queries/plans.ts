import 'server-only'

import { cacheLife, cacheTag } from 'next/cache'
import { logger } from '@/lib/logger'
import { createPublicClient } from '@/lib/supabase/public'
import { type PlanCatalogue, toCatalogue } from '../lib/plans'

/**
 * The offered plans, the same for everyone. Read through the cookie-free
 * client behind `'use cache'`, so /pricing, the home page and the sitemap
 * stay prerendered (CLAUDE.md §15); revalidated hourly, or at once by
 * `revalidateTag(PLANS_TAG)` from whatever changes a plan.
 */
export const PLANS_TAG = 'mail-plans'

const COLUMNS =
  'code, name, price_kobo, monthly_cap, daily_cap, max_domains, max_members, log_retention_days, is_offered, sort_order, updated_at'

/**
 * The plans, or null when they could not be read — the page then withholds
 * prices rather than guess one (N5b). A failed read throws inside the cache
 * and is caught out here, so a dropped connection is never cached as "no
 * plans" for an hour.
 */
export async function getPlanCatalogue(): Promise<PlanCatalogue | null> {
  try {
    return await loadPlanCatalogue()
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'plans read failed — withholding prices for this request',
    )
    return null
  }
}

/** The cached read behind getPlanCatalogue. Exported for tests. */
export async function loadPlanCatalogue(): Promise<PlanCatalogue> {
  'use cache'
  cacheTag(PLANS_TAG)
  cacheLife('hours')

  const { data, error } = await createPublicClient()
    .from('plans')
    .select(COLUMNS)
    .eq('is_offered', true)
    .order('sort_order', { ascending: true })
  if (error) throw new Error(`plans: ${error.message}`)
  return toCatalogue(data ?? [])
}
