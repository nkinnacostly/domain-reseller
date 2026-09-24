import 'server-only'

import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'
import { describeDevice } from '../lib/user-agent'

/** One place the account is signed in (PRD FR-A5). */
export type AccountSession = {
  id: string
  /** "Chrome on macOS" — from the user agent the session last reported. */
  device: string
  ip: string | null
  signedInAt: string
  lastActiveAt: string
  /** The session reading this page. */
  isCurrent: boolean
}

/**
 * The signed-in account's sessions, this device first, then by last activity.
 * Read as the user: `my_sessions()` returns only the caller's own (migration
 * 26). Null when they cannot be read, so the page can say so rather than
 * claim there are none.
 */
export async function getSessions(): Promise<AccountSession[] | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('my_sessions')
  if (error) {
    logger.error({ err: error.message }, 'sessions could not be read')
    return null
  }

  return (data ?? [])
    .map((row) => ({
      id: row.id,
      device: describeDevice(row.user_agent),
      ip: row.ip || null,
      signedInAt: row.created_at,
      lastActiveAt: row.last_used_at,
      isCurrent: row.is_current === true,
    }))
    .sort(
      (a, b) =>
        Number(b.isCurrent) - Number(a.isCurrent) ||
        Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt),
    )
}
