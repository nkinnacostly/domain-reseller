import 'server-only'

import type { User } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { cache } from 'react'
import { getSessionUser } from '@/features/auth/queries/security'
import { createClient } from '@/lib/supabase/server'
import {
  CURRENT_ACCOUNT_COOKIE,
  type Membership,
  pickAccount,
  readMemberships,
} from '../lib/current'

/**
 * The person's Mail accounts, read as them (RLS: `members` and `accounts`
 * by membership, migration 43). Once per request. A failed read throws, so
 * the page shows its error state rather than "no accounts" (S11).
 */
export const getMemberships = cache(
  async (): Promise<{ user: User; memberships: Membership[] } | null> => {
    const user = await getSessionUser()
    if (!user) return null
    const supabase = await createClient()
    const { data, error } = await supabase
      .from('members')
      .select(
        'role, created_at, accounts(id, name, state, ses_status, plan_code, website, use_case, expected_monthly_volume, created_at)',
      )
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })
    if (error) throw new Error(`memberships could not be read: ${error.code ?? 'unknown'}`)
    return { user, memberships: readMemberships(data) }
  },
)

export type CurrentAccount = {
  user: User
  memberships: Membership[]
  current: Membership
}

/** The account the dashboard shows, or null when the person has none (onboarding). */
export const getCurrentAccount = cache(async (): Promise<CurrentAccount | null> => {
  const data = await getMemberships()
  if (!data) return null
  const remembered = (await cookies()).get(CURRENT_ACCOUNT_COOKIE)?.value
  const current = pickAccount(data.memberships, remembered)
  return current ? { ...data, current } : null
})
