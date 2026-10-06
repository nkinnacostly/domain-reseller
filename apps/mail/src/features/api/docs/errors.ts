import type { ApiErrorName } from '@dr/shared/mail'

/**
 * The errors page's words for each `name` (MAIL-SPEC §6): when the API
 * answers it, and what to do. The statuses come from the API's own table
 * (`API_ERROR_STATUS`); a test holds this list to every name there is.
 */
export const ERROR_DOCS: Record<ApiErrorName, { when: string; next: string }> = {
  validation_error: {
    when: 'The request is not valid: the message names each field and what is wrong with it. Also 409 (an Idempotency-Key reused for a different request, or an email that has already left the queue), 413 (a request over 4 MB) and 405 (a method the path does not take).',
    next: 'Fix the request. Sending it again unchanged gets the same answer.',
  },
  unauthorized: {
    when: 'The API key is missing, malformed, wrong or revoked.',
    next: 'Send Authorization: Bearer with a live key from the dashboard.',
  },
  forbidden: {
    when: 'The key may not do this: a sending key reading or changing emails, a key limited to another domain, or the sandbox refusing a recipient who is not a member. Also while a new account is still being set up for sending.',
    next: 'Use a key with the access it needs, or the right from address. In the sandbox, send to your own members. For a new account, try again in a few minutes.',
  },
  not_found: {
    when: 'Nothing with that id belongs to this account — or the path does not exist.',
    next: 'Check the id and that the key is this account’s.',
  },
  rate_limited: {
    when: 'More requests with this key than it may make: 10 a second, with bursts of 20.',
    next: 'Wait for the seconds in retry-after, then send again.',
  },
  quota_exceeded: {
    when: 'The account has reached its plan’s cap for the day or the month (Lagos time) — or, rarely, our own shared sending limit; the message says which.',
    next: 'Wait for the seconds in retry-after, or move to a larger plan.',
  },
  domain_not_verified: {
    when: 'The from address’s domain is not verified on this account.',
    next: 'Finish the domain’s DNS records under Domains, or send from a verified domain.',
  },
  account_paused: {
    when: 'Sending is paused on this account.',
    next: 'The dashboard says why. Email us if you think it is a mistake.',
  },
  internal_error: {
    when: 'Something failed on our side.',
    next: 'Try again in a moment. If it keeps happening, write to us with the x-request-id.',
  },
}
