import 'server-only'

import { createClient } from '@/lib/supabase/server'
import { type AuditRow, readAuditRows } from '../lib/audit'

/** How much of the log one page shows: the newest first. */
export const AUDIT_PAGE_SIZE = 100

/**
 * The account's security log (MAIL-SPEC §9 `account_audit_log`), newest
 * first, read as the person: owners and admins only (RLS, migration 43).
 * Null when it could not be read.
 */
export async function getAuditLog(accountId: string): Promise<AuditRow[] | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('account_audit_log')
    .select('id, at, actor, actor_user_id, action, target, detail')
    .eq('account_id', accountId)
    .order('at', { ascending: false })
    .order('id', { ascending: false })
    .limit(AUDIT_PAGE_SIZE)
  if (error) return null
  return readAuditRows(data)
}
