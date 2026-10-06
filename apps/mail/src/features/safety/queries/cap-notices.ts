import 'server-only'

import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'
import { type CapNotice, pickCapNotice } from '../lib/cap-notice'

/**
 * This day's and month's cap notice for the dashboard banner (MAIL-SPEC §8),
 * read as the member (RLS: `cap_notices` by membership, migration 51). A
 * read that fails shows no notice: the Overview's meters still say it.
 */
export async function getCapNotice(
  accountId: string,
  period: { day: string; monthStart: string },
): Promise<CapNotice | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('cap_notices')
    .select('scope, period_start, level, cap, used')
    .eq('account_id', accountId)
    .in('period_start', [period.day, period.monthStart])
  if (error) {
    logger.warn({ err: error.code ?? null }, 'cap notices could not be read')
    return null
  }
  return pickCapNotice(data, period)
}
