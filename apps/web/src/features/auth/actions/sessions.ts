'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { logger } from '@/lib/logger'
import { partialAuthAction } from '@/lib/safe-action'
import { authMessage, FALLBACK_MESSAGE } from '../lib/messages'

/**
 * Signing other devices out (PRD FR-A5).
 *
 * Plain `authAction`, not `elevatedAction`: this only takes access away — it
 * cannot move a domain or change a setting — and the person reaching for it
 * is usually reacting to a device they don't recognise. Asking for a fresh
 * code first would slow the response down for no protection gained, and the
 * post-reset hold would block it exactly when it matters most.
 *
 * It does need a session that has finished signing in. With two-factor on,
 * a session that has not entered its code — someone holding only the
 * password — must not be able to sign the owner out everywhere. The panel's
 * pages already require that; an action can be called from any page, so it
 * checks for itself.
 */

type Result = { error: string } | { ok: true }
type Supabase = Awaited<ReturnType<typeof import('@/lib/supabase/server').createClient>>

const UNFINISHED =
  'Enter the code from your authenticator app to finish signing in, then sign other devices out.'

async function hasFinishedSignIn(supabase: Supabase): Promise<boolean> {
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  return !(aal?.nextLevel === 'aal2' && aal.currentLevel !== 'aal2')
}

export const revokeSession = partialAuthAction
  .inputSchema(z.object({ sessionId: z.uuid() }))
  .action(async ({ parsedInput, ctx }): Promise<Result> => {
    if (!(await hasFinishedSignIn(ctx.supabase))) return { error: UNFINISHED }

    // Runs as the user: the function deletes only the caller's own sessions,
    // and never the one making the call (migration 26).
    const { data, error } = await ctx.supabase.rpc('revoke_my_session', {
      p_session_id: parsedInput.sessionId,
    })
    if (error) {
      logger.error({ err: error.message }, 'session revoke failed')
      return { error: FALLBACK_MESSAGE }
    }
    revalidatePath('/app/settings')
    // Nothing deleted: it ended already — expired, or signed out elsewhere.
    if (data !== true) return { error: 'That device was already signed out.' }
    return { ok: true }
  })

export const signOutOtherSessions = partialAuthAction.action(async ({ ctx }): Promise<Result> => {
  if (!(await hasFinishedSignIn(ctx.supabase))) return { error: UNFINISHED }

  const { error } = await ctx.supabase.auth.signOut({ scope: 'others' })
  if (error) return { error: authMessage(error.code) }
  revalidatePath('/app/settings')
  return { ok: true }
})
