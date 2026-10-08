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
  manual: {
    label: 'Added to the list',
    tone: 'neutral',
    why: 'Put here on purpose — an unsubscribe, say, or a list brought from another provider.',
  },
}

/** The choice an import asks for: why the file's addresses were on the old provider's list. */
export const IMPORT_REASON: Record<SuppressionReason, { label: string; hint: string }> = {
  bounce: {
    label: 'They bounced',
    hint: 'Hard bounces: the address does not exist or never accepts mail.',
  },
  complaint: { label: 'They complained', hint: 'Their owners marked an email as spam.' },
  manual: {
    label: 'They unsubscribed, or another reason',
    hint: 'Unsubscribes, and anyone else you must not email.',
  },
}

export const SOURCE: Record<SuppressionSource, string> = {
  ses: 'Amazon SES',
  customer: 'This account',
  admin: 'MyDomainsHub support',
}

/** Removing an address risks the account's reputation, so owners and admins only (migration 49). */
export const canRemoveSuppressions = (role: MemberRole) => role === 'owner' || role === 'admin'

/** Importing a list is the same people's (migration 68). */
export const canImportSuppressions = canRemoveSuppressions

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

const count = (n: unknown) => new Intl.NumberFormat('en-NG').format(Number(n) || 0)

export const IMPORT_FALLBACK =
  'Something went wrong on our end, and this part of the list was not added. Try the import again: addresses already added are skipped.'

/** import_suppressions' refusals (migration 68), in words. */
export function importRefusal(answer: Record<string, unknown>): string {
  switch (answer.code) {
    case 'unauthorized':
      return SQL_WORDS.unauthorized as string
    case 'forbidden':
      return 'Only the account’s owner or an admin can import a list.'
    case 'account_closed':
      return 'This account is closed, so nothing can be added to its list.'
    case 'import_limit':
      return answer.per === 'list'
        ? `The list can hold ${count(answer.max)} addresses, and this import would pass that. Email us if you need more.`
        : `An account can import ${count(answer.max)} addresses a day, and ${count(answer.added)} were added today. The rest can be imported tomorrow (Lagos time): addresses already added are skipped.`
    default:
      return IMPORT_FALLBACK
  }
}
