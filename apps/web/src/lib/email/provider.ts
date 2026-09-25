import 'server-only'

import { env } from '@/lib/env'

/**
 * Which service sends our email (L1): Brevo by default, Amazon SES once
 * EMAIL_PROVIDER=ses. The auth emails follow it, and so does the privacy
 * notice, which must name the processor actually in use (N9b).
 */
export type EmailProvider = 'brevo' | 'ses'

export function emailProvider(): EmailProvider {
  // Unset only where validation is skipped, when the schema default applies.
  return env.EMAIL_PROVIDER === 'ses' ? 'ses' : 'brevo'
}
