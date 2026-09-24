import 'server-only'

import type { User } from '@supabase/supabase-js'
import { SENSITIVE_CHANGE_NEEDS_TWO_FACTOR } from '@/features/auth/lib/security'
import { mustTurnOnTwoFactor } from '@/features/auth/queries/two-factor'
import type { createClient } from '@/lib/supabase/server'

/**
 * The one place a sensitive bulk change — nameservers (FR-N2), turning the
 * transfer lock off, contact privacy — is checked for the account before it
 * starts, over and above the second factor `elevatedAction` asks for. Each
 * of those actions calls it first, before any lookup or write, so a rule
 * about the account (such as FR-A2's two-factor requirement for larger
 * portfolios) is added here once and holds for all of them.
 *
 * Deliberately not called by bulk renewal: a rule that blocks registry
 * changes must never stop someone paying to keep their domains.
 */
export type GuardContext = {
  supabase: Awaited<ReturnType<typeof createClient>>
  user: Pick<User, 'id' | 'email'>
}

/**
 * FR-A2: an account holding more than ten domains changes none of them in
 * bulk until two-factor is on. When the rule cannot be read, nothing starts:
 * a registry change can wait a minute.
 */
export async function guardSensitiveBulkChange(
  ctx: GuardContext,
): Promise<{ error: string } | null> {
  const needsTwoFactor = await mustTurnOnTwoFactor(ctx.supabase, ctx.user.id)
  if (needsTwoFactor === null) return { error: 'That did not go through. Try again in a moment.' }
  return needsTwoFactor ? { error: SENSITIVE_CHANGE_NEEDS_TWO_FACTOR } : null
}
