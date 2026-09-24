import 'server-only'

import { logger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/service'
import { describeDevice } from '../lib/user-agent'

/**
 * Security notices (SEC-4) the web raises: a sign-in from a new device, a
 * password change, two-factor turned on or off. The database queues the
 * email (migration 31) and the gateway sends it.
 *
 * Neither function throws. The change has already happened by the time we
 * get here; a notice that could not be queued is logged, never allowed to
 * turn a successful sign-in or password change into an error.
 */

export type AccountNotice = 'password_changed' | 'two_factor_on' | 'two_factor_off'

export async function queueAccountNotice(userId: string, kind: AccountNotice): Promise<void> {
  try {
    const { error } = await createServiceClient().rpc('queue_account_email', {
      p_user_id: userId,
      p_kind: kind,
    })
    if (error) logger.error({ err: error.message, kind }, 'account notice not queued')
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), kind },
      'account notice not queued',
    )
  }
}

/**
 * A sign-in, from the device this request came from ("Chrome on macOS").
 * The first device an account uses is only remembered; a new one after that
 * is a security email.
 */
export async function noteSignIn(userId: string, userAgent: string | null): Promise<void> {
  try {
    const { error } = await createServiceClient().rpc('note_sign_in', {
      p_user_id: userId,
      p_device: describeDevice(userAgent),
    })
    if (error) logger.error({ err: error.message }, 'sign-in not recorded')
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'sign-in not recorded')
  }
}
