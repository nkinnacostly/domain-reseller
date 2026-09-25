'use server'

import { cookies, headers } from 'next/headers'
import { z } from 'zod'
import { clientKey } from '@/lib/client-ip'
import { env } from '@/lib/env'
import { actionClient } from '@/lib/safe-action'
import {
  HUMAN_CHECK_REFUSED,
  HUMAN_CHECK_UNANSWERED,
  humanCheckError,
  MAX_TOKEN_LENGTH,
  verifyTurnstile,
} from '@/lib/turnstile'
import { HUMAN_PASS_COOKIE, HUMAN_PASS_SECONDS, signHumanPass } from '../lib/human-pass'
import { humanPassSecret } from '../queries/allowance'

/**
 * Turns a passed Turnstile check into a search pass (SEC-9): a signed,
 * httpOnly cookie for two hours, bound to this address, that lifts the search
 * allowance and lets bulk search start (queries/allowance.ts).
 *
 * Setting a cookie in an action re-renders the page it was called from, so a
 * results page that asked for the check comes back with results.
 */
export const confirmHuman = actionClient
  .inputSchema(z.object({ token: z.string().min(1).max(MAX_TOKEN_LENGTH) }))
  .action(async ({ parsedInput }): Promise<{ passed: true } | { error: string }> => {
    const requestHeaders = await headers()
    const check = await verifyTurnstile(parsedInput.token, requestHeaders)
    if (!check.ok) return { error: humanCheckError(check) }
    // Nothing was checked, so nothing is proved: a pass now would be free for anyone.
    if (check.skipped) return { error: HUMAN_CHECK_REFUSED }

    const secret = humanPassSecret()
    if (!secret) return { error: HUMAN_CHECK_UNANSWERED }

    const pass = signHumanPass(secret, clientKey(requestHeaders), Math.floor(Date.now() / 1000))
    ;(await cookies()).set(HUMAN_PASS_COOKIE, pass, {
      // Single and bulk search both live under /search; nothing else needs it.
      path: '/search',
      httpOnly: true,
      sameSite: 'lax',
      secure: env.NODE_ENV === 'production',
      maxAge: HUMAN_PASS_SECONDS,
    })
    return { passed: true }
  })
