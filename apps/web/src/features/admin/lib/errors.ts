import { AppError, type AppErrorCode } from '@dr/shared/errors'
import { RESET_HOLD_HOURS } from '@/features/auth/lib/security'

/**
 * Every refusal an admin can meet, in words (docs/ADMIN-SPEC.md §2.4): the
 * `admin:*` codes the gate raises, each wrapper's codes (§3.1.2), and the
 * gateway's. A raw database or supplier message is never shown (N10).
 */

export const NEEDS_CODE_WORDS =
  "Confirm it's you with the code from your authenticator app to continue."
export const WRONG_CODE_WORDS = "That code didn't work. Check your authenticator app and try again."

/** describeHold's words, without a time the gate does not know (§2.4). */
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
  test_admin: "Test administrators can't do this on live records.",
  TEST_ADMIN: "Test administrators can't do this on live records.",
  RATE_LIMITED: "You've looked up a lot of customers this hour. Wait, or ask the owner.",
  UNKNOWN_ACTION: "The dashboard asked for something the database doesn't know. Nothing changed.",
  unknown_action: "The dashboard asked for something the database doesn't know. Nothing changed.",
  bad_side: 'That side is not one the dashboard knows.',
  bad_range: 'Choose dates in order, at most three years apart.',
  bad_outcome: 'That outcome is not one the database records.',
  not_claimed: 'That note was never claimed by the gateway.',
  request_key: 'This request had no key, so it could not be checked for a repeat. Try again.',
  request_key_mismatch:
    'This looks like a repeat of a different request. Close the dialog and start again.',
  REASON: "Give a reason of at least 10 characters. Don't include personal details.",
  NO_REASON: 'That entry has no reason to remove.',
  NOT_FOUND: 'That record no longer exists. Reload the page.',
  REFUSED_BY_DATABASE:
    'The database refused this, so nothing changed. Reload the page: the record may have moved on.',
  WRONG_CODE: WRONG_CODE_WORDS,

  // ── Refunds ──
  NOT_HELD: 'This refund is no longer held. Reload the page to see where it is.',
  LINE_NOT_FAILED:
    "This refund's line didn't fail — it was registered after all — so no money is owed back.",
  NOT_RETRYABLE: "This can't be retried from where it is now. Reload the page.",
  OWNER_ONLY: 'Only the owner can do this to a cancelled refund.',
  LINE_RETRIED:
    'This refund was cancelled because its registration was retried. Retrying the refund could pay for a domain the customer has.',
  CHECK_PROVIDER:
    'Flutterwave was already called for this refund. Check its dashboard and tick the box to say no refund of this charge went through.',
  CONFIRM_NO_MONEY: "Tick the box to say we haven't returned this money, and won't.",
  NOT_CANCELLABLE: "This refund can't be cancelled from where it is now.",
  HAS_PROVIDER_REFUND:
    'Flutterwave has a refund for this. If the money went back, record the Flutterwave refund instead.',
  BAD_REFERENCE: "That isn't a Flutterwave refund id.",
  NOT_RECORDABLE: "This refund can't be recorded as paid from where it is now.",
  FLW_NOT_VERIFIED:
    'Check the refund with Flutterwave first. It must be this charge, this amount, completed, and checked in the last 15 minutes.',

  // ── Incidents ──
  ALREADY_RESOLVED: 'This incident is already resolved.',
  OUTCOME_REQUIRED: 'Choose what happened: money is owed on this kind of incident.',
  OUTCOME_NOT_MET: "What you chose isn't shown by the records yet. Check it, then try again.",

  // ── Jobs ──
  TRANSFER_CODE_GONE:
    "A failed transfer can't be retried: its transfer code was deleted. The customer starts a new transfer.",
  REFUND_AT_PROVIDER:
    "This line's refund has reached Flutterwave. Settle the refund before registering again.",
  NOT_RETRIED: "The job didn't go back to the queue. Reload the page.",
  NOT_NEEDS_ATTENTION: 'Only a job waiting for a person can be failed.',
  PAYMENT_NOT_VERIFIED:
    "This charge couldn't be confirmed, so only Retry is offered. If it still can't be confirmed, the owner closes it in the SQL editor (DEPLOY §6).",
  USE_RETRY:
    'Only Retry is offered: stopping this could block a transfer-out, or leave a change half-recorded.',
  TRANSFER_OUT_PROTECTED:
    "An unlock can't be stopped from here: it could block the customer's transfer-out (ICANN).",
  READ_REGISTRY_FIRST:
    'Read the registry first: it must show the domain is not in our account, after the last registration attempt and in the last 15 minutes.',
  LEDGER_SHOWS_CHARGE:
    "DomainNameAPI's ledger shows a charge for this domain since the job started. Don't fail it: retry, or ask.",
  READ_TRANSFER_FIRST:
    'Read the transfer state first: it must show the registry refused or cancelled it, in the last 15 minutes.',
  ALREADY_SENT:
    'This certificate order may have reached the supplier, so it is only read from now on — never failed or sent again.',

  // ── Prices, limits and extensions ──
  NOT_PENDING: 'This rate is no longer waiting for review.',
  RATE_TOO_OLD: 'Too old to activate — the daily job will fetch a fresh one.',
  NEWER_RATE_ACTIVE: 'A newer rate is already active. Reject this one.',
  UNKNOWN_KEY: "That setting can't be changed here.",
  OUT_OF_RANGE: 'A value is outside what this setting allows.',
  NO_CHANGES: 'Nothing was changed.',
  PAUSE_REASON: 'Say why the extension is paused, in 3 to 120 characters.',
  NO_PRICE: 'DomainNameAPI lists no price for this product yet.',
  INCOMPLETE_PRODUCT: "This product's details are incomplete, so it can't be sold yet.",

  // ── Presets ──
  PROVIDER: 'Name the provider in 2 to 60 characters.',
  PROVIDER_EXISTS: 'That provider already has a preset. Change it instead.',
  SOURCE_NOT_ALLOWED:
    "The source must be the provider's own documentation, on a site listed for it. New sites are added in the SQL editor.",
  NOT_HOSTNAMES: 'Each nameserver must be a hostname such as ns1.example.com.',
  NAMESERVER_COUNT: 'Give 2 to 13 nameservers, or none for a host that assigns them per domain.',
  DRAFT_OPEN: 'This provider already has a draft. Publish or discard it first.',
  REGISTRAR_DEFAULT: "The registrar's default nameservers are changed in the SQL editor only.",
  NOT_OPEN: 'This draft is already published or discarded.',
  NOT_CHECKED: 'Check the draft in public DNS first; it must pass after it was saved.',
  CHECKER_HID_IT:
    'The health check hid this preset. It shows again by itself once its nameservers resolve.',
  NO_CHANGE: 'It is already that way.',

  // ── Emails, domains, customers, top-ups ──
  NOT_FAILED: 'Only a failed email can be sent again.',
  COMPLAINED: 'The recipient reported this email as spam. It is not sent again.',
  BOUNCED: 'This email bounced. It is not sent again.',
  NOT_SYNCABLE: 'Only a live domain — active, expired or in redemption — can be read again.',
  NO_GATEWAY: 'No gateway is reading this side right now, so nothing would read it.',
  BAD_QUERY: 'Search by an exact email address, order number or domain.',
  NOT_TOPUP: 'That ledger entry is not a top-up.',
  ALREADY_RECORDED: "This top-up's cost is already recorded. Correct it instead.",
  NOT_CURRENT: 'That record was already corrected. Correct the newest one.',

  // ── The gateway's claim on a note (D22) ──
  ADMIN_NOTE_REFUSED: 'The gateway refused the audit note, so nothing was read. Try again.',
  NOT_INTENT: 'The gateway refused the audit note, so nothing was read. Try again.',
  ACTION_MISMATCH: 'The gateway refused the audit note, so nothing was read. Try again.',
  LABEL_MISMATCH: 'The gateway refused the audit note, so nothing was read. Try again.',
  TARGET_MISMATCH: 'The gateway refused the audit note, so nothing was read. Try again.',
  SIDE_MISMATCH: 'The gateway refused the audit note, so nothing was read. Try again.',
  EXPIRED: 'That took too long, so nothing was read. Try again.',
  USED: 'That request was already used. Try again.',
  REVOKED: 'Your admin access was removed.',

  // ── The gateway itself ──
  ADMIN_DISABLED: "Live reads are off: the gateway's admin secret is not set.",
  OTHER_SIDE: 'The gateway reads the other side. Switch sides to read this.',
  WRITES_OFF: 'No gateway is reading this side right now.',
  TOO_SOON: 'This was read moments ago. Wait a little before reading it again.',
  SUPPLIER_BUSY: 'DomainNameAPI is busy right now. Try again in a moment.',
  VALIDATION_FAILED: "That isn't something the gateway can read.",
  DRAFT_NOT_DUE: 'Only an open draft with nameservers can be checked.',
  FLW_REFUND_NOT_FOUND: 'Flutterwave has no refund with that id.',
  FLW_UNAVAILABLE: "Flutterwave didn't answer. Try again shortly.",
  NOT_PRODUCTION: 'Only the production gateway applies the price list.',
  NO_SUPPLIER_KEY: "The gateway isn't set up to read this.",
  UNREADABLE: "DomainNameAPI's answer couldn't be read. Nothing was changed.",
  DISABLED: 'This check is off.',
  NOT_ALLOWED: "That read isn't allowed from the dashboard.",
  SUPPLIER_UNAVAILABLE: "DomainNameAPI couldn't be reached. Try again shortly.",
  SUPPLIER_IP_BLOCKED: "DomainNameAPI refused the gateway's address. Operations need to look.",
  SUPPLIER_AUTH: "DomainNameAPI refused the gateway's credentials. Operations need to look.",
}

export const FALLBACK_WORDS = "That didn't go through, and nothing changed. Try again."

/** What any server action says about an error nobody wrote words for (safe-action.ts). */
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
  weak_sign_in: 'MFA_REQUIRED',
  rate_limited: 'RATE_LIMITED',
  not_found: 'NOT_FOUND',
}

/**
 * A refusal an admin sees in words. It keeps the code it came from, so the
 * dialog can tell a refused answer (a new request key) from a lost one.
 */
export class AdminRefusal extends AppError {
  readonly adminCode: string
  constructor(code: string) {
    const bare = bareAdminCode(code)
    super(APP_CODES[bare.toLowerCase()] ?? 'FORBIDDEN', adminErrorWords(bare))
    this.name = 'AdminRefusal'
    this.adminCode = bare
  }
}

/**
 * What every admin action answers (§2.4). `message` is always these words,
 * never a raw database or supplier string. A read adds its `data`.
 */
export type AdminResult<T = undefined> =
  | {
      ok: true
      auditId: number
      after?: Record<string, unknown>
      replayed?: true
      data?: T
    }
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

/** A refusal answered in place, for a code the action itself found. */
export function refusedResult(code: string, auditId?: number): AdminResult<never> {
  return {
    ok: false,
    code,
    message: adminErrorWords(code),
    ...(auditId !== undefined ? { auditId } : {}),
  }
}

type SafeActionAnswer<T> = {
  data?: AdminResult<T> | undefined
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
 * A server action's whole answer as an AdminResult, for ConfirmAction. A
 * refusal in words is `REFUSED` (the dialog takes a new request key); an
 * error nobody wrote words for may have happened after the change committed,
 * so it is `UNKNOWN_OUTCOME` and the key is kept.
 */
export function adminOutcome<T>(answer: SafeActionAnswer<T> | undefined): AdminResult<T> {
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

/**
 * §2.4: a raise from the gate (`admin:role`) or a wrapper's JSON `code`
 * (`ROLE`), as an error whose message is safe to show. Anything else — a
 * database message nobody wrote for people — gets the fallback words (N10).
 */
export function adminAccessError(raw: string | null | undefined): AdminRefusal {
  const code = raw?.trim() ?? ''
  if (RAISED.test(code) || code in ADMIN_ERROR_WORDS) return new AdminRefusal(code)
  return new AdminRefusal('UNKNOWN')
}
