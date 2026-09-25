/**
 * What the email sender needs from a provider (L1): send one message, and —
 * for a provider that can be asked — read back what became of one (FR-NT3).
 * Brevo can be asked; SES cannot, and pushes its delivery events to the web's
 * `/api/email/ses-events` instead (migration 34).
 */

export type EmailProvider = 'brevo' | 'ses'

export type OutgoingMessage = {
  to: string
  subject: string
  html: string
  text: string
  tags: string[]
}

export type SendOutcome =
  | { ok: true; messageId: string | null }
  /** `permanent`: the provider refused this message itself — sending it again cannot help. */
  | { ok: false; permanent: boolean; error: string }

export type Delivery = 'delivered' | 'bounced' | 'deferred' | null

export interface Mailer {
  readonly provider: EmailProvider
  send(message: OutgoingMessage): Promise<SendOutcome>
  /** What the provider has recorded for one message; absent where it cannot be asked. */
  delivery?: (messageId: string) => Promise<Delivery>
}
