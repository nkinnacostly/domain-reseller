import { BUSINESS } from '@/lib/business'

/**
 * Reporting abuse (MAIL-SPEC §7.7) is an email for now: a mailto with the
 * fields we need, so nothing is stored here. The admin package brings a
 * report form and the abuse queue.
 */
export const ABUSE_FIELDS = [
  'The address it came from (the From line)',
  'When you received it, with your time zone',
  'What is wrong: spam, phishing, malware, impersonation, or something else',
  'The full message headers',
  'How we can reach you, if you want to hear back',
] as const

export const ABUSE_SUBJECT = `Abuse report: ${BUSINESS.product}`

/** `mailto:` with the subject and the fields to fill in, encoded. */
export function abuseMailto(): string {
  const body = `${ABUSE_FIELDS.map((field) => `${field}:\n\n`).join('')}`
  return `mailto:${BUSINESS.email}?subject=${encodeURIComponent(ABUSE_SUBJECT)}&body=${encodeURIComponent(body)}`
}
