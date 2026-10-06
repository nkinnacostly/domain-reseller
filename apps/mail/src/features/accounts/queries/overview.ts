import 'server-only'

import { cache } from 'react'
import { logger } from '@/lib/logger'
import type { MemberRole } from '@/lib/safe-action'
import { createClient } from '@/lib/supabase/server'
import { type AccountUsage, readUsage } from '../lib/usage'

/**
 * What the Overview shows (MAIL-SPEC §10), read as the person (RLS):
 * this month's and today's sends against the caps SQL applies
 * (`account_usage`, migration 46), the plan's name, and what the next steps
 * need to know. Each part fails on its own: a part that could not be read is
 * null, and the page says so for that part (S11), never a zero.
 */

export type Plan = { code: string; name: string; maxMembers: number }

export type Overview = {
  usage: AccountUsage | null
  plan: Plan | null
  verifiedDomains: number | null
  /** Null for a viewer, who cannot read keys (RLS), or when unreadable. */
  activeKeys: number | null
}

export async function getPlan(code: string): Promise<Plan | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('plans')
    .select('code, name, max_members')
    .eq('code', code)
    .maybeSingle()
  if (error || !data) return null
  return { code: data.code, name: data.name, maxMembers: data.max_members }
}

/** `account_usage` once per request: the banner and the Overview both need it. */
export const getUsage = cache(async (accountId: string): Promise<AccountUsage | null> => {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('account_usage', { p_account_id: accountId })
  if (error) {
    logger.error({ err: error.code }, 'account usage could not be read')
    return null
  }
  return readUsage(data)
})

export async function getOverview(
  accountId: string,
  role: MemberRole,
  planCode: string,
): Promise<Overview> {
  const supabase = await createClient()
  const [usage, plan, domains, keys] = await Promise.all([
    getUsage(accountId),
    getPlan(planCode),
    supabase
      .from('domains')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .eq('status', 'verified'),
    role === 'viewer'
      ? Promise.resolve(null)
      : supabase
          .from('api_keys')
          .select('id', { count: 'exact', head: true })
          .eq('account_id', accountId)
          .is('revoked_at', null),
  ])
  return {
    usage,
    plan,
    verifiedDomains: domains.error ? null : (domains.count ?? 0),
    activeKeys: !keys || keys.error ? null : (keys.count ?? 0),
  }
}
