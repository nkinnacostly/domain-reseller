import type { ApiError } from '@dr/shared/mail'
import { apiError } from '@dr/shared/mail'

/**
 * The domain functions' refusals (migration 47) in words: what happened,
 * why, and what to do next — for the dashboard, and as the v1 API's error
 * answers (MAIL-SPEC §6). A code with no words of its own gets the fallback,
 * never the raw code.
 */

export type DomainAnswer = {
  ok?: boolean
  code?: string
  max?: number
  count?: number
  until?: string
  domainId?: string
  reason?: string
  field?: string
} & Record<string, unknown>

export const DOMAIN_FALLBACK = 'Something went wrong on our end. Nothing was changed. Try again.'

const untilWords = (iso: string | undefined) =>
  iso
    ? new Intl.DateTimeFormat('en-NG', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Africa/Lagos',
      }).format(new Date(iso))
    : null

const WORDS: Record<string, (answer: DomainAnswer) => string> = {
  unauthorized: () => 'Your session has ended. Sign in again to continue.',
  not_found: () => 'That domain was not found on this account.',
  forbidden: (answer) =>
    answer.reason === 'sandbox'
      ? 'The sandbox sending address is ours, and leaves with the sandbox. It cannot be removed.'
      : 'Your role in this account cannot do that. Ask its owner, an admin or a developer.',
  account_closed: () => 'This account is closed, so its domains cannot change.',
  validation: () =>
    'That is not a domain we can verify. Type the domain only, such as acme.ng or mail.acme.ng.',
  reserved: () => 'mydomainshub.com and its subdomains are ours. Add a domain of your own.',
  already_added: () => 'This domain is already on this account.',
  in_use: () =>
    'This domain is in use on another account. If it is yours, email hello@mydomainshub.com and we will sort it out.',
  in_use_pending: (answer) => {
    const until = untilWords(answer.until)
    return `Another account added this domain and is still verifying it${until ? ` (until ${until}, Lagos)` : ''}. If it is yours, email hello@mydomainshub.com; if that claim is not proven by then, it is released.`
  },
  releasing: () =>
    'This domain is being released from an earlier claim. Try again in a few minutes.',
  domain_limit: (answer) =>
    `This plan holds ${answer.max ?? 'no more'} ${answer.max === 1 ? 'domain' : 'domains'}, and they are all in use. Remove one, or move to a bigger plan.`,
  emails_queued: (answer) =>
    `${answer.count === 1 ? 'One email is' : `${answer.count ?? 'Some'} emails are`} still waiting to be sent from this domain. Wait for ${answer.count === 1 ? 'it' : 'them'} to go, or cancel ${answer.count === 1 ? 'it' : 'them'}, then remove the domain.`,
  not_failed: () => 'Only a failed domain can be tried again.',
}

export function domainMessage(answer: DomainAnswer | null | undefined): string {
  const words = answer?.code ? WORDS[answer.code] : undefined
  return words ? words(answer as DomainAnswer) : DOMAIN_FALLBACK
}

export function asDomainAnswer(value: unknown): DomainAnswer | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as DomainAnswer)
    : null
}

/** The same refusals as the v1 API answers them. */
export function domainApiError(answer: DomainAnswer): ApiError {
  const message = domainMessage(answer)
  switch (answer.code) {
    case 'unauthorized':
      return apiError('unauthorized', 'The API key is missing, wrong or revoked.')
    case 'forbidden':
      return apiError(
        'forbidden',
        'Managing domains takes a full-access API key. Use one, or manage domains in the dashboard.',
      )
    case 'not_found':
      return apiError('not_found', 'No domain with that id belongs to this account.')
    case 'account_closed':
      return apiError('forbidden', message)
    case 'in_use':
    case 'in_use_pending':
    case 'releasing':
    case 'already_added':
    case 'emails_queued':
      return { ...apiError('validation_error', message), status: 409 }
    case 'domain_limit':
      return apiError('forbidden', message)
    default:
      return answer.code === 'validation' || answer.code === 'reserved'
        ? apiError('validation_error', message)
        : apiError('internal_error', DOMAIN_FALLBACK)
  }
}
