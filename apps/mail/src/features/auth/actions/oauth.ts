'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { actionClient } from '@/lib/safe-action'
import { createClient } from '@/lib/supabase/server'
import { oauthCallbackUrl } from '../lib/links'
import { safeNext } from '../lib/redirect'

/**
 * "Continue with Google" (MAIL-SPEC §7.1, the shop's FR-A1): sign in, or
 * create a sign-in, with a Google account. Supabase starts the OAuth flow and
 * keeps the PKCE verifier in this browser's cookies; Google sends the person
 * back to Mail's /auth/callback, which exchanges the code. An address that
 * already has a sign-in — from the shop or Mail — signs in to it.
 */
export const continueWithGoogle = actionClient
  .inputSchema(z.object({ next: z.string().max(2000).optional() }))
  .action(async ({ parsedInput }): Promise<{ error: string }> => {
    const supabase = await createClient()
    const next = safeNext(parsedInput.next, env.NEXT_PUBLIC_MAIL_URL)
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: oauthCallbackUrl(next),
        skipBrowserRedirect: true,
        // Always ask which Google account, so a shared computer never signs
        // someone in as whoever used it last.
        queryParams: { prompt: 'select_account' },
      },
    })
    if (error || !data?.url) {
      logger.error({ err: error?.message }, 'google sign-in could not start')
      return { error: 'Google sign-in is not available just now. Use your email instead.' }
    }
    redirect(data.url)
  })
