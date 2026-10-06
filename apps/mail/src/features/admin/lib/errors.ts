import { AppError, type AppErrorCode } from '@dr/shared/errors'
import { RESET_HOLD_HOURS } from '@/features/auth/lib/security'

/**
 * Every refusal Mail's admin can meet, in words (the shop's ADMIN-SPEC §2.4,
 * MAIL-SPEC §10): the `admin:*` codes the gate raises, and each
 * `admin_mail_*` wrapper's codes (migration 51). A raw database message is
 * never shown.
 */

export const NEEDS_CODE_WORDS =
  "Confirm it's you with the code from your authenticator app to continue."
export const WRONG_CODE_WORDS = "That code didn't work. Check your authenticator app and try again."
export const CODE_RATE_LIMITED_WORDS =
  'Too many codes were tried just now, so nothing changed. Wait a minute, then enter a new code.'
export const CODE_NOT_CHECKED_WORDS =
  "We couldn't check your code just now, so nothing changed. Try again in a moment."
export const TEST_ADMIN_WORDS =
  "Test administrators can't do this: they act on test accounts only, and never resume or change caps."

const HELD_WORDS = `For your security, changes like this are paused for ${RESET_HOLD_HOURS} hours after a password reset.`

export const ADMIN_ERROR_WORDS: Readonly<Record<string, string>> = {
  // ── Who is asking (admin_session, admin_gate) ──
  not_admin: 'This needs an administrator.',
  needs_code: NEEDS_CODE_WORDS,
  NEEDS_CODE: NEEDS_CODE_WORDS,
  held: HELD_WORDS,
  HELD: HELD_WORDS,
  role: "Your admin role can't do this. Ask the owner.",
  ROLE: "Your admin role can't do this. Ask the owner.",
  weak_sign_in:
    "Sign in with your password or Google, then enter your code. A sign-in link can't open the admin area.",
  factor_mismatch: "This sign-in used an authenticator that isn't linked to your admin access.",
  test_admin: TEST_ADMIN_WORDS,
  TEST_ADMIN: TEST_ADMIN_WORDS,
  UNKNOWN_ACTION: "The dashboard asked for something the database doesn't know. Nothing changed.",
  bad_filter: 'That filter is not one the admin knows.',
  request_key: 'This request had no key, so it could not be checked for a repeat. Try again.',
  request_key_mismatch:
    'This looks like a repeat of a different request. Close the dialog and start again.',
  REASON: "Give a reason of at least 10 characters. Don't include personal details.",
  NOT_FOUND: 'That account no longer exists. Reload the page.',
  WRONG_CODE: WRONG_CODE_WORDS,
  CODE_RATE_LIMITED: CODE_RATE_LIMITED_WORDS,
  CODE_NOT_CHECKED: CODE_NOT_CHECKED_WORDS,

  // ── Review (§7.2) ──
  NOT_SANDBOX: 'This account is no longer in the sandbox. Reload the page to see where it is.',
  NO_VERIFIED_DOMAIN: 'The account has no verified domain yet, so it cannot leave the sandbox.',
  PROFILE_INCOMPLETE:
    'The account profile is not complete — a website, what it sends and its monthly volume — so it cannot leave the sandbox.',

  // ── Pause and resume (§7.4, MR5) ──
  NOT_PAUSABLE: 'Only an account in the sandbox or active can be paused. Reload the page.',
  NOT_PAUSED: 'This account is not paused. Reload the page.',
  SES_PAUSED:
    'AWS itself has paused this account’s tenant. It is not resumed from here: it goes through an AWS support case, and SES reinstates the tenant.',
  FINDING_MISMATCH:
    'The finding you read is no longer the open one. Reload the page, read the finding again, then resume.',

  // ── Caps (§10) ──
  ACCOUNT_CLOSED: 'This account is closed.',
  OUT_OF_RANGE:
    'A cap is outside what is allowed: at least 1, the day no more than the month, and the day within the SES budget Mail may use.',
  NO_CHANGE: 'Those are already the caps.',
}

export const FALLBACK_WORDS = "That didn't go through, and nothing changed. Try again."

/** What an admin action says about an error nobody wrote words for (lib/safe-action's words). */
export const SERVER_CRASH_WORDS = 'Something went wrong on our end. Please try again.'

/**
 * The answer was lost or the server failed part-way: it may have gone
 * through. A retry with the same request key replays it rather than acting
 * twice, so the dialog keeps its key for this one.
 */
export const UNKNOWN_OUTCOME = 'UNKNOWN_OUTCOME'
export const LOST_ANSWER_WORDS =
  "We couldn't tell whether that went through. Try again: if it did, trying again shows it and does nothing twice."

/** The bare code: `admin:needs_code` → `needs_code`. */
export function bareAdminCode(code: string): string {
  return code.startsWith('admin:') ? code.slice('admin:'.length) : code
}

/** Words for a code — `admin:needs_code` or `NEEDS_CODE` alike — or the fallback. */
export function adminErrorWords(code: string | null | undefined): string {
  if (!code) return FALLBACK_WORDS
  const bare = bareAdminCode(code)
  return ADMIN_ERROR_WORDS[bare] ?? ADMIN_ERROR_WORDS[bare.toUpperCase()] ?? FALLBACK_WORDS
}

const APP_CODES: Readonly<Record<string, AppErrorCode>> = {
  needs_code: 'MFA_REQUIRED',
  wrong_code: 'MFA_REQUIRED',
  code_rate_limited: 'RATE_LIMITED',
  code_not_checked: 'MFA_REQUIRED',
  weak_sign_in: 'MFA_REQUIRED',
  not_found: 'NOT_FOUND',
}

/** A refusal an admin sees in words; it keeps the code it came from. */
export class AdminRefusal extends AppError {
  readonly adminCode: string
  constructor(code: string) {
    const bare = bareAdminCode(code)
    super(APP_CODES[bare.toLowerCase()] ?? 'FORBIDDEN', adminErrorWords(bare))
    this.name = 'AdminRefusal'
    this.adminCode = bare
  }
}

/** What every admin action answers. `message` is always these words. */
export type AdminResult =
  | { ok: true; auditId: number; after?: Record<string, unknown>; replayed?: true }
  | { ok: false; code: string; message: string; auditId?: number }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A wrapper's JSON answer (`admin_record`'s shape) as an AdminResult. */
export function toAdminResult(json: unknown): AdminResult {
  if (!isRecord(json)) return { ok: false, code: 'UNKNOWN', message: FALLBACK_WORDS }
  const auditId = typeof json.auditId === 'number' ? json.auditId : undefined
  if (json.ok === true && auditId !== undefined) {
    return {
      ok: true,
      auditId,
      ...(isRecord(json.after) ? { after: json.after } : {}),
      ...(json.replayed === true ? { replayed: true as const } : {}),
    }
  }
  const code = typeof json.code === 'string' && json.code ? json.code : 'UNKNOWN'
  return {
    ok: false,
    code,
    message: adminErrorWords(code),
    ...(auditId !== undefined ? { auditId } : {}),
  }
}

type SafeActionAnswer = {
  data?: AdminResult | undefined
  serverError?: string | undefined
  validationErrors?: unknown
}

function firstMessage(errors: unknown): string | null {
  if (!isRecord(errors)) return null
  for (const value of Object.values(errors)) {
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
    const nested = firstMessage(value)
    if (nested) return nested
  }
  return null
}

/**
 * A server action's whole answer as an AdminResult, for the confirm dialog.
 * A refusal in words takes a new request key; an error nobody wrote words for
 * may have happened after the change committed, so it is UNKNOWN_OUTCOME and
 * the key is kept.
 */
export function adminOutcome(answer: SafeActionAnswer | undefined): AdminResult {
  if (answer?.data) return answer.data
  if (answer?.serverError) {
    return answer.serverError === SERVER_CRASH_WORDS
      ? { ok: false, code: UNKNOWN_OUTCOME, message: LOST_ANSWER_WORDS }
      : { ok: false, code: 'REFUSED', message: answer.serverError }
  }
  if (answer?.validationErrors) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: firstMessage(answer.validationErrors) ?? 'Check what you entered and try again.',
    }
  }
  return { ok: false, code: UNKNOWN_OUTCOME, message: LOST_ANSWER_WORDS }
}

const RAISED = /^admin:[a-z_]+$/

/** What an unrecognised admin call error says in the server log; never shown. */
export const UNRECOGNISED_ADMIN_ERROR =
  'an admin call failed with an error that is not an admin code'

/**
 * A raise from the gate (`admin:role`) or a wrapper's code, as a refusal whose
 * words are safe to show. Anything else may have come after the wrapper
 * committed: a plain Error, never its text, so the dialog keeps its key.
 */
export function adminAccessError(raw: string | null | undefined): AdminRefusal | Error {
  const code = raw?.trim() ?? ''
  if (RAISED.test(code) || Object.hasOwn(ADMIN_ERROR_WORDS, code)) return new AdminRefusal(code)
  return new Error(UNRECOGNISED_ADMIN_ERROR)
}
