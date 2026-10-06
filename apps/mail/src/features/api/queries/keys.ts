import 'server-only'

import { API_KEY_PERMISSIONS, type ApiKeyPermission } from '@dr/shared/mail'
import { createClient } from '@/lib/supabase/server'

/**
 * The API keys page (MAIL-SPEC §10), read as the member (RLS: owners,
 * admins and developers read keys; the hash and the rate-limit counters are
 * not granted to anyone). Null when the read failed, so the page shows its
 * error state rather than "no keys" (S11).
 */

export type DashboardKey = {
  id: string
  name: string
  prefix: string
  permission: ApiKeyPermission
  domainId: string | null
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

export type KeyDomain = { id: string; name: string; status: string }

const isPermission = (value: unknown): value is ApiKeyPermission =>
  typeof value === 'string' && (API_KEY_PERMISSIONS as readonly string[]).includes(value)

export async function getKeys(accountId: string): Promise<DashboardKey[] | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('api_keys')
    .select('id, name, prefix, permission, domain_id, created_at, last_used_at, revoked_at')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
  if (error || !data) return null
  return data.flatMap((row) =>
    isPermission(row.permission)
      ? [
          {
            id: row.id,
            name: row.name,
            prefix: row.prefix,
            permission: row.permission,
            domainId: row.domain_id,
            createdAt: row.created_at,
            lastUsedAt: row.last_used_at,
            revokedAt: row.revoked_at,
          },
        ]
      : [],
  )
}

/** Domains a sending key may be limited to: any of the account's not removed (create_api_key). */
export async function getKeyDomains(accountId: string): Promise<KeyDomain[] | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('domains')
    .select('id, name, status')
    .eq('account_id', accountId)
    .neq('status', 'removed')
    .order('name', { ascending: true })
  if (error || !data) return null
  return data
}
