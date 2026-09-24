import { AppError } from '@dr/shared/errors'
import { headers } from 'next/headers'
import { createSafeActionClient } from 'next-safe-action'
import {
  describeHold,
  hasFreshSecondFactor,
  resetHoldUntil,
  SENSITIVE_CHANGE_NEEDS_TWO_FACTOR,
} from '@/features/auth/lib/security'
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

/**
 * Sensitive operations (PRD FR-A3, FR-A6, SEC-2, SEC-3): registrant change,
 * transfer-lock off, auth-code reveal, nameserver change, wallet withdrawal.
 * Needs a second factor verified in the last 15 minutes, and no post-reset hold.
 */
export const elevatedAction = authAction.use(async ({ next, ctx }) => {
  const [{ data: aal }, { data: profile }] = await Promise.all([
    ctx.supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    ctx.supabase.from('profiles').select('password_reset_at').eq('id', ctx.user.id).single(),
  ])

  // No verified authenticator at all: asking for its code would send them to
  // a code screen with nothing to enter. Say what is missing instead (SEC-2).
  if (aal?.nextLevel === 'aal1') {
    throw new AppError('MFA_REQUIRED', SENSITIVE_CHANGE_NEEDS_TWO_FACTOR)
  }

  const now = new Date()
  if (
    aal?.currentLevel !== 'aal2' ||
    !hasFreshSecondFactor(aal.currentAuthenticationMethods ?? [], now)
  ) {
    throw new AppError(
      'MFA_REQUIRED',
      "Confirm it's you with the code from your authenticator app to continue.",
    )
  }

  const hold = resetHoldUntil(profile?.password_reset_at ?? null, now)
  if (hold) throw new AppError('FORBIDDEN', describeHold(hold))

  return next({ ctx })
})
