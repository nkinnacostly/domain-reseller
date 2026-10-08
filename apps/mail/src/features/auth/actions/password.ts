'use server'

import { createClient as createStandaloneClient } from '@supabase/supabase-js'
import { redirect } from 'next/navigation'
import { env } from '@/lib/env'
import { authAction, partialAuthAction } from '@/lib/safe-action'
import { retryingFetch } from '@/lib/supabase/retry'
import { authMessage } from '../lib/messages'
import { startedFromEmailLink } from '../lib/security'
import { queueAccountNotice, recordResetHold } from '../queries/notices'
import { changePasswordSchema, newPasswordSchema } from '../schemas'

type Result = { error: string } | { ok: true }

/**
 * Sets a new password from a reset link, as the shop does (FR-A6). Only a
 * session that came from an email link may — anyone else changes it under
 * Your security, where the current one is required. Afterwards every other
 * session is signed out, the shop's 24-hour hold starts (the password is
 * shared, MAIL-SPEC M5), and the account-wide security email is queued.
 */
export const completePasswordReset = partialAuthAction
  .inputSchema(newPasswordSchema)
  .action(async ({ parsedInput, ctx }): Promise<Result> => {
    const { data: aal } = await ctx.supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (!startedFromEmailLink(aal?.currentAuthenticationMethods ?? [])) {
      return {
        error:
          'Open the reset link from your email to set a new password here. To change it while signed in, use Your security in Settings.',
      }
    }

    const { error } = await ctx.supabase.auth.updateUser({ password: parsedInput.password })
    if (error) return { error: authMessage(error.code) }

    await recordResetHold(ctx.user.id)
    await queueAccountNotice(ctx.user.id, 'password_changed')
    await ctx.supabase.auth.signOut({ scope: 'others' })
    redirect('/dashboard/settings/security?reset=1')
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
      {
        auth: { persistSession: false, autoRefreshToken: false },
        // Mail's one fetch for Supabase; it never sends an Auth call twice.
        global: { fetch: retryingFetch() },
      },
    )
    const { error: wrong } = await verifier.auth.signInWithPassword({
      email,
      password: parsedInput.current,
    })
    if (wrong) {
      // A sign-in made with Google has no password until one is set.
      const google = (ctx.user.app_metadata?.providers as string[] | undefined)?.includes('google')
      return {
        error:
          wrong.code !== 'invalid_credentials'
            ? authMessage(wrong.code)
            : google
              ? "That isn't your current password. If you signed up with Google and never set one, sign out and use “Forgot your password?” on the sign-in page to create it."
              : "That isn't your current password.",
      }
    }
    await verifier.auth.signOut({ scope: 'local' })

    const { error } = await ctx.supabase.auth.updateUser({ password: parsedInput.password })
    if (error) return { error: authMessage(error.code) }
    await queueAccountNotice(ctx.user.id, 'password_changed')
    await ctx.supabase.auth.signOut({ scope: 'others' })
    return { ok: true }
  })
