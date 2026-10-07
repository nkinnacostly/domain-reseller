import type { ApiKeyPermission } from '@dr/shared/mail'
import type { MemberRole } from '@/lib/safe-action'

/**
 * Who may do what with API keys (MAIL-SPEC MR7, §9; migration 43's
 * create_api_key and revoke_api_key, which decide again on every call):
 * owners and admins make and revoke any key; developers make and revoke
 * sending keys; viewers cannot read keys at all (RLS on `api_keys`).
 */

export const PERMISSION_LABEL: Record<ApiKeyPermission, string> = {
  full: 'Full access',
  sending: 'Sending only',
}

/** What each permission lets a key do — what the API's handlers check. */
export const PERMISSION_SUMMARY: Record<ApiKeyPermission, string> = {
  sending: 'Sends email (one or a batch), and nothing else.',
  full: 'Sends email, reads the email log, reschedules and cancels queued emails, and manages keys.',
}

export const canSeeKeys = (role: MemberRole) => role !== 'viewer'

/** The permissions `role` may give a new key, least first. */
export function permissionsFor(role: MemberRole): readonly ApiKeyPermission[] {
  if (role === 'owner' || role === 'admin') return ['sending', 'full']
  if (role === 'developer') return ['sending']
  return []
}

export function canRevoke(role: MemberRole, permission: ApiKeyPermission): boolean {
  return permissionsFor(role).includes(permission)
}

/** SQL's refusals for a key, in words: what happened and what to do. */
const KEY_WORDS: Record<string, string> = {
  unauthorized: 'Your session has ended. Sign in again to continue.',
  not_found: 'That key was not found, or it is not in this account.',
  forbidden:
    'Your role cannot do that with this key. Developers make and revoke sending keys; owners and admins any key.',
  account_closed: 'This account is closed, so its keys cannot change.',
}

const FIELD_WORDS: Record<string, string> = {
  name: 'Give the key a name of 1 to 60 characters.',
  permission: 'Choose what the key may do.',
  domain: 'That domain is not in this account. Choose another, or none.',
  key: 'The key could not be made. Try again.',
}

export const KEY_FALLBACK = 'Something went wrong on our end. Nothing was changed. Try again.'

export function keyRefusal(
  answer: { code?: unknown; field?: unknown; max?: unknown } | null,
): string {
  const code = typeof answer?.code === 'string' ? answer.code : ''
  if (code === 'validation') {
    return (typeof answer?.field === 'string' && FIELD_WORDS[answer.field]) || KEY_FALLBACK
  }
  if (code === 'key_limit') {
    // Migration 54 (review 13): settings.api_keys_max live keys an account.
    const max = typeof answer?.max === 'number' ? answer.max : null
    return `This account has ${max ?? 'the most'} live keys, the most it may hold. Revoke one you no longer use, then make the new one.`
  }
  return KEY_WORDS[code] ?? KEY_FALLBACK
}
