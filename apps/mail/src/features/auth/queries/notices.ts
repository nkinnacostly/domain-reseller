import 'server-only'

import { logger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/service'
import { describeDevice } from '../lib/user-agent'

/**
 * The sign-in is the shop's (MAIL-SPEC M5): one password and one
 * authenticator for both products. So what changes them from Mail does what
 * the shop does — the account-wide security emails (the shop's SEC-4,
 * queued by `public.note_sign_in` / `queue_account_email`, migration 31) and
 * the 24-hour hold after a reset (`public.profiles.password_reset_at`, the
 * shop's FR-A6). Without the hold, a reset made through Mail would let
 * someone who has broken into the inbox skip the shop's.
 *
 * These are the only public-schema calls Mail makes; all use the secret key,
 * on the server only (N6). None throws: the change has already happened by
 * the time we get here, so a notice that could not be queued is logged (ids
 * only, N13), never allowed to turn a success into an error.
 */

export type AccountNotice = 'password_changed' | 'two_factor_on' | 'two_factor_off'

const failure = (err: unknown) => (err instanceof Error ? err.message : String(err))

export async function queueAccountNotice(userId: string, kind: AccountNotice): Promise<void> {
  try {
    const { error } = await createServiceClient()
      .schema('public')
      .rpc('queue_account_email', { p_user_id: userId, p_kind: kind })
    if (error) logger.error({ err: error.message, kind }, 'account notice not queued')
  } catch (err) {
    logger.error({ err: failure(err), kind }, 'account notice not queued')
  }
}

/** A sign-in, from the device this request came from ("Chrome on macOS"). */
export async function noteSignIn(userId: string, userAgent: string | null): Promise<void> {
  try {
    const { error } = await createServiceClient()
      .schema('public')
      .rpc('note_sign_in', { p_user_id: userId, p_device: describeDevice(userAgent) })
    if (error) logger.error({ err: error.message }, 'sign-in not recorded')
  } catch (err) {
    logger.error({ err: failure(err) }, 'sign-in not recorded')
  }
}

/** Starts the shop's 24-hour hold after a reset. Users cannot write the column themselves. */
export async function recordResetHold(userId: string): Promise<void> {
  try {
    const { error } = await createServiceClient()
      .schema('public')
      .from('profiles')
      .update({ password_reset_at: new Date().toISOString() })
      .eq('id', userId)
    if (error) logger.error({ err: error.message }, 'password reset hold not recorded')
  } catch (err) {
    logger.error({ err: failure(err) }, 'password reset hold not recorded')
  }
}
