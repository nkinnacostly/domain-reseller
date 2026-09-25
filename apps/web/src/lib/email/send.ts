import 'server-only'

import { sendWithBrevo } from './brevo'
import { emailProvider } from './provider'
import { sendWithSes } from './ses'
import type { OutgoingEmail, SendResult } from './types'

export type { OutgoingEmail, SendResult } from './types'

/** Sends one email through the provider EMAIL_PROVIDER names (L1). */
export function sendEmail(email: OutgoingEmail): Promise<SendResult> {
  return emailProvider() === 'ses' ? sendWithSes(email) : sendWithBrevo(email)
}
