'use server'

import { createClient as createStandaloneClient } from '@supabase/supabase-js'
import { redirect } from 'next/navigation'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { authAction } from '@/lib/safe-action'
import { createServiceClient } from '@/lib/supabase/service'
import { authMessage } from '../lib/messages'
import { startedFromEmailLink } from '../lib/security'
import { queueAccountNotice } from '../queries/notices'
import { changePasswordSchema, newPasswordSchema } from '../schemas'

type Result = { error: string } | { ok: true }

/**
 * Sets a new password from a reset link (FR-A6).
 *
 * Only a session that came from an email link may do this — anyone else
 * changes their password in Settings, where the current one is required.
 * Afterwards: every other session is signed out, and sensitive operations are
 * held for 24 hours, because a reset is exactly what someone who has broken
 * into your email would do.
 */
export const completePasswordReset = authAction
  .inputSchema(newPasswordSchema)
  .action(async ({ parsedInput, ctx }): Promise<Result> => {
    const { data: aal } = await ctx.supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (!startedFromEmailLink(aal?.currentAuthenticationMethods ?? [])) {
      return {
        error:
          'Open the reset link from your email to set a new password here. To change it while signed in, use Settings.',
      }
    }

    const { error } = await ctx.supabase.auth.updateUser({ password: parsedInput.password })
    if (error) return { error: authMessage(error.code) }

    // Written with the secret key: users cannot clear their own hold (the
    // column is excluded from their update grant — migration 08).
    const { error: holdError } = await createServiceClient()
      .from('profiles')
      .update({ password_reset_at: new Date().toISOString() })
      .eq('id', ctx.user.id)
    if (holdError) logger.error({ err: holdError }, 'could not record password reset hold')
    await queueAccountNotice(ctx.user.id, 'password_changed')

    await ctx.supabase.auth.signOut({ scope: 'others' })
    redirect('/app/settings?reset=1')
  })

/** Changing a known password: the current one is required, checked out of band. */
export const changePassword = authAction
  .inputSchema(changePasswordSchema)
  .action(async ({ parsedInput, ctx }): Promise<Result> => {
    const email = ctx.user.email
    if (!email) return { error: authMessage(undefined) }

    // A throwaway client, so checking the password never replaces the
    // session in this browser's cookies.
    const verifier = createStandaloneClient(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } },
    )
    const { error: wrong } = await verifier.auth.signInWithPassword({
      email,
      password: parsedInput.current,
    })
    if (wrong) {
      return {
        error:
          wrong.code === 'invalid_credentials'
            ? "That isn't your current password."
            : authMessage(wrong.code),
      }
    }
    await verifier.auth.signOut({ scope: 'local' })

    const { error } = await ctx.supabase.auth.updateUser({ password: parsedInput.password })
    if (error) return { error: authMessage(error.code) }
    await queueAccountNotice(ctx.user.id, 'password_changed')

    await ctx.supabase.auth.signOut({ scope: 'others' })
    return { ok: true }
  })
