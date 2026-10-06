import type { Tone } from '@/components/common/status-pill'
import type { MemberRole } from '@/lib/safe-action'

/**
 * The Suppressions page in words (MAIL-SPEC §7.5, §10). An address is on the
 * list because it hard-bounced or its owner marked an email as spam; SES
 * keeps the same list for the account's tenant and drops any email to it.
 */

export type SuppressionReason = 'bounce' | 'complaint' | 'manual'
export type SuppressionSource = 'ses' | 'customer' | 'admin'

export const REASON: Record<SuppressionReason, { label: string; tone: Tone; why: string }> = {
  bounce: {
    label: 'Bounced',
    tone: 'danger',
    why: 'The receiving server said this address does not exist or will never accept mail.',
  },
  complaint: {
    label: 'Marked as spam',
    tone: 'warning',
    why: 'Its owner reported one of this account’s emails as spam.',
  },
  manual: { label: 'Added by hand', tone: 'neutral', why: 'Someone added it to the list.' },
}

export const SOURCE: Record<SuppressionSource, string> = {
  ses: 'Amazon SES',
  customer: 'This account',
  admin: 'MyDomainsHub support',
}

/** Removing an address risks the account's reputation, so owners and admins only (migration 49). */
export const canRemoveSuppressions = (role: MemberRole) => role === 'owner' || role === 'admin'

const SQL_WORDS: Record<string, string> = {
  unauthorized: 'Your session has ended. Sign in again to continue.',
  not_found: 'That address is no longer on the list.',
  forbidden: 'Only the account’s owner or an admin can remove an address from the list.',
}

export const SUPPRESSION_FALLBACK =
  'Something went wrong on our end. The address is still on the list. Try again.'

export const SES_REFUSED =
  'Amazon SES did not remove the address from its list just now, so it is still on ours too. Try again in a minute.'

export const SES_UNAVAILABLE =
  'Addresses cannot be removed right now: this is on our side. The address is still on the list; try again later.'

export function suppressionRefusal(answer: { code?: unknown }): string {
  return (typeof answer.code === 'string' && SQL_WORDS[answer.code]) || SUPPRESSION_FALLBACK
}
