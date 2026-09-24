import 'server-only'

import { logger } from '@/lib/logger'
import type { createServiceClient } from '@/lib/supabase/service'
import { type Allowance, parseAllowance } from '../lib/allowance'

/**
 * The account's daily domain allowance on one side (SEC-11, migration 32):
 * test orders are counted against test orders, live against live. Null when
 * it cannot be read or is not the shape we expect — the caller refuses, since
 * a limit nobody could check is not a limit.
 */
export async function readAllowance(
  service: ReturnType<typeof createServiceClient>,
  userId: string,
  testMode: boolean,
): Promise<Allowance | null> {
  const { data, error } = await service.rpc('account_domain_allowance', {
    p_user_id: userId,
    p_test_mode: testMode,
  })
  const allowance = error ? null : parseAllowance(data)
  if (!allowance) logger.error({ err: error?.message }, 'domain allowance could not be checked')
  return allowance
}
