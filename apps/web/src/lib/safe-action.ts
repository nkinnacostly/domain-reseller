import { AppError } from '@dr/shared/errors'
import { headers } from 'next/headers'
import { createSafeActionClient } from 'next-safe-action'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'

/**
 * Server Action clients.
 *
 * `actionClient`  — unauthenticated (search, public lookups)
 * `authAction`    — requires a signed-in user
 * `elevatedAction`— requires AAL2 (2FA verified this session) for sensitive
 *                   operations: registrant change, transfer-lock off, auth-code
 *                   reveal, nameserver change, wallet withdrawal (PRD SEC-2)
 */
export const actionClient = createSafeActionClient({
  handleServerError(error) {
    if (error instanceof AppError) return error.message
    logger.error({ err: error }, 'unhandled server action error')
    return 'Something went wrong on our end. Please try again.'
  },
}).use(async ({ next }) => {
  const requestHeaders = await headers()
  return next({ ctx: { requestId: requestHeaders.get('x-request-id') ?? crypto.randomUUID() } })
})

export const authAction = actionClient.use(async ({ next }) => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) throw new AppError('UNAUTHENTICATED', 'Please sign in to continue.')

  return next({ ctx: { user, supabase } })
})

export const elevatedAction = authAction.use(async ({ next, ctx }) => {
  const { data } = await ctx.supabase.auth.mfa.getAuthenticatorAssuranceLevel()

  if (data?.currentLevel !== 'aal2') {
    throw new AppError(
      'MFA_REQUIRED',
      'Confirm your identity with two-factor authentication to continue.',
    )
  }

  return next({ ctx })
})
