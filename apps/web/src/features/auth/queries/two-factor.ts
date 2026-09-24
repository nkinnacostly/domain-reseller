import 'server-only'

import { cache } from 'react'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'
import { NOT_HELD_STATUSES, twoFactorRequired } from '../lib/security'
import { getAccount } from './account'

/**
 * Whether the mandatory two-factor rule (FR-A2) applies to an account, read
 * as the user (RLS) — their own domains, their own factors.
 */

type Supabase = Awaited<ReturnType<typeof createClient>>

/** Domains the account holds, demo rows aside; null when they cannot be counted. */
export async function countHeldDomains(supabase: Supabase, userId: string): Promise<number | null> {
  const { count, error } = await supabase
    .from('domains')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .neq('source', 'demo')
    .not('local_status', 'in', `(${NOT_HELD_STATUSES.join(',')})`)
  if (error || typeof count !== 'number') {
    logger.error({ err: error?.message }, 'held domains could not be counted')
    return null
  }
  return count
}

/**
 * For an action about to take an order or a transfer: must this account turn
 * two-factor on first? Null when that cannot be told — the caller refuses,
 * as with any check it could not make. Most accounts are under the threshold,
 * so their factors are not read at all.
 */
export async function mustTurnOnTwoFactor(
  supabase: Supabase,
  userId: string,
): Promise<boolean | null> {
  const held = await countHeldDomains(supabase, userId)
  if (held === null) return null
  if (!twoFactorRequired(held)) return false
  const { data, error } = await supabase.auth.mfa.listFactors()
  if (error || !data) {
    logger.error({ err: error?.message }, 'two-factor factors could not be read')
    return null
  }
  return !data.totp.some((factor) => factor.status === 'verified')
}

export type TwoFactorRequirement = { held: number; required: boolean; hasFactor: boolean }

/**
 * The rule as the panel shows it — the notice and Settings. Request-scoped,
 * so a page that asks twice counts once. Null when signed out or unreadable:
 * better no notice than a wrong one, since the actions check for themselves.
 */
export const getTwoFactorRequirement = cache(async (): Promise<TwoFactorRequirement | null> => {
  const account = await getAccount()
  if (!account) return null
  const held = await countHeldDomains(await createClient(), account.id)
  if (held === null) return null
  return { held, required: twoFactorRequired(held), hasFactor: Boolean(account.totpFactor) }
})
