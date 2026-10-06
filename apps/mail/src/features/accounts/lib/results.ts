/**
 * The answers of Mail's account functions (migrations 43 and 46) in words:
 * what happened, why, and what to do next (the shop's UX-7). A code with no
 * words of its own gets the fallback, never the raw code.
 */

export type SqlAnswer = { ok?: boolean; code?: string; max?: number; field?: string } & Record<
  string,
  unknown
>

export const RESULT_FALLBACK = 'Something went wrong on our end. Nothing was changed. Try again.'

const WORDS: Record<string, string | ((answer: SqlAnswer) => string)> = {
  unauthorized: 'Your session has ended. Sign in again to continue.',
  not_found: 'That account was not found, or you are not one of its members.',
  forbidden: 'Your role in this account cannot do that. Ask its owner or an admin.',
  account_closed: 'This account is closed, so it cannot be changed.',
  limit: (answer) =>
    `You already own ${answer.max ?? 'the most'} open Mail accounts, the most one person can own. Close one, or ask to be invited to another instead.`,
  member_limit: (answer) =>
    `This plan has ${answer.max ?? 'no more'} member ${answer.max === 1 ? 'seat' : 'seats'}, counting invites still waiting, and they are all taken. Revoke an invite, remove a member, or move to a bigger plan.`,
  already_member: 'That person is already a member of this account.',
  already_invited:
    'An invite to that address is already waiting. Revoke it first to send a new one.',
  accepted: 'That invite has already been used.',
  expired: 'That invite has expired. Ask whoever sent it for a new one.',
  wrong_email:
    'This invite was sent to a different email address. Sign in with the address it was sent to.',
  not_a_member: 'That person is no longer a member of this account.',
  owner_role: 'The owner’s role changes only when the owner hands the account over.',
  use_leave: 'To remove yourself, use “Leave this account”.',
  owner_must_transfer:
    'The owner cannot leave. Hand the account over to another member first, then leave.',
  needs_aal2:
    'Your sign-in has two-factor on: enter a code from your authenticator app first, then try again.',
  validation: 'Some details were not accepted. Check them and try again.',
}

export function resultMessage(answer: SqlAnswer | null | undefined): string {
  const words = answer?.code ? WORDS[answer.code] : undefined
  if (!words) return RESULT_FALLBACK
  return typeof words === 'function' ? words(answer as SqlAnswer) : words
}

/** Narrows an RPC's JSON answer to the shape every one of these functions returns. */
export function asAnswer(value: unknown): SqlAnswer | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as SqlAnswer) : null
}
