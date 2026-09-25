'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { actionClient } from '@/lib/safe-action'
import { createClient } from '@/lib/supabase/server'
import { callbackUrl } from '../lib/links'
import { safeNext } from '../lib/redirect'

/**
 * "Continue with Google" (FR-A1): sign in, or create an account, with a
 * Google account. Supabase starts the OAuth flow and keeps the PKCE verifier
 * in this browser's cookies; Google sends the person back to
 * /auth/callback, which exchanges the code, notes the device (SEC-4) and
 * goes on to `next`. An address already on an account signs in to that
 * account — Supabase links a verified Google email to it.
 */
export const continueWithGoogle = actionClient
  .inputSchema(z.object({ next: z.string().max(2000).optional() }))
  .action(async ({ parsedInput }): Promise<{ error: string }> => {
    const supabase = await createClient()
    const next = safeNext(parsedInput.next, env.NEXT_PUBLIC_APP_URL)
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: callbackUrl('oauth', next),
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
