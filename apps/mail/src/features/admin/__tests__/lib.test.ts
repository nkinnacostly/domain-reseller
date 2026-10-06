import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canAct, MAIL_ADMIN_TIERS, rank } from '../lib/actions'
import {
  ADMIN_NOT_FOUND_PATH,
  ADMIN_SOURCES,
  NOT_ADMIN,
  STRANGER_HEADER,
  UNANSWERED,
} from '../lib/door'
import {
  ADMIN_ERROR_WORDS,
  AdminRefusal,
  adminAccessError,
  adminErrorWords,
  adminOutcome,
  bareAdminCode,
  FALLBACK_WORDS,
  LOST_ANSWER_WORDS,
  SERVER_CRASH_WORDS,
  toAdminResult,
  UNKNOWN_OUTCOME,
  UNRECOGNISED_ADMIN_ERROR,
} from '../lib/errors'
import {
  findingKindOf,
  formatCount,
  formatPpm,
  formatWhen,
  heartbeatLabel,
  sesStatusOf,
  stateOf,
  stateReasonOf,
} from '../lib/format'
import {
  adminCsp,
  adminDecision,
  adminHeaders,
  adminNonce,
  isAdminPath,
  toAdminStatus,
} from '../lib/gate'
import {
  accountStateOf,
  auditActionOf,
  domainStatusFilterOf,
  listHref,
  pageOf,
  tenantQueryOf,
} from '../lib/params'

const MIGRATION = readFileSync(
  join(__dirname, '../../../../../../supabase/migrations/00000000000051_mail_safety.sql'),
  'utf8',
)

describe('the action map mirrors admin_tier (migration 51)', () => {
  const rows = [
    ...MIGRATION.matchAll(
      /\('(mail\.[a-z_]+)',\s+'(owner|operator|viewer)',\s*(true|false),\s*'(\w+)'\)/g,
    ),
  ].map(([, action, minRole, money, testRule]) => ({
    action,
    minRole,
    money: money === 'true',
    testRule,
  }))

  it('has every Mail action SQL knows, with the same tier, and no other', () => {
    expect(rows).toHaveLength(5)
    for (const row of rows) {
      expect(MAIL_ADMIN_TIERS[row.action as keyof typeof MAIL_ADMIN_TIERS], row.action).toEqual({
        minRole: row.minRole,
        money: row.money,
        testRule: row.testRule,
      })
    }
    expect(Object.keys(MAIL_ADMIN_TIERS).sort()).toEqual(rows.map((row) => row.action).sort())
  })

  it('offers each action only to a role SQL would let take it', () => {
    expect(rank('owner')).toBeGreaterThan(rank('operator'))
    expect(canAct({ role: 'operator', testOnly: false }, 'mail.approve')).toBe(true)
    expect(canAct({ role: 'viewer', testOnly: false }, 'mail.approve')).toBe(false)
    expect(canAct({ role: 'operator', testOnly: false }, 'mail.resume')).toBe(false)
    expect(canAct({ role: 'owner', testOnly: false }, 'mail.resume')).toBe(true)
    // MR5: a test admin never resumes nor changes caps, whatever its role.
    expect(canAct({ role: 'operator', testOnly: true }, 'mail.pause')).toBe(true)
    expect(canAct({ role: 'owner', testOnly: true }, 'mail.cap_override')).toBe(false)
  })

  it('has words for every code a Mail wrapper answers', () => {
    const codes = new Set(
      [...MIGRATION.matchAll(/v_code := '([A-Z_]+)'/g)].map(([, code]) => code as string),
    )
    expect(codes.size).toBeGreaterThan(8)
    for (const code of codes) expect(ADMIN_ERROR_WORDS[code], code).toBeTruthy()
  })
})

describe('the door (D9)', () => {
  it('sends a marked /admin request and every unanswered path to one 404, capturing nothing', () => {
    expect(ADMIN_NOT_FOUND_PATH).toBe('/__not-found')
    expect(STRANGER_HEADER).toBe('x-mdh-stranger')
    expect(ADMIN_SOURCES).toEqual(['/admin', '/admin/(.*)'])
    expect(ADMIN_SOURCES.join('')).not.toMatch(/:[a-z]/)
    const notAdmin = new RegExp(`^${NOT_ADMIN}$`)
    expect(notAdmin.test('admin')).toBe(false)
    expect(notAdmin.test('admin/accounts')).toBe(false)
    expect(notAdmin.test('administrators')).toBe(true)
    expect(notAdmin.test('pricing')).toBe(true)
    expect(new RegExp(`^${UNANSWERED}$`).test('/_next/static/x.js')).toBe(false)
  })
})

describe('the gate (ADMIN-SPEC §2.3)', () => {
  it('reads admin_status’s word and nothing else', () => {
    expect(toAdminStatus('ok')).toBe('ok')
    expect(toAdminStatus('weak_sign_in')).toBe('weak_sign_in')
    expect(toAdminStatus('OK')).toBe('not_admin')
    expect(toAdminStatus(null)).toBe('not_admin')
    expect(toAdminStatus({ status: 'ok' })).toBe('not_admin')
  })

  it('decides a 404, a code, or the way in', () => {
    expect(adminDecision('not_admin')).toEqual({ kind: 'not_found' })
    expect(adminDecision('needs_code')).toEqual({ kind: 'verify' })
    for (const status of ['ok', 'factor_mismatch', 'weak_sign_in'] as const) {
      expect(adminDecision(status)).toEqual({ kind: 'continue' })
    }
  })

  it('knows /admin and below, not look-alikes', () => {
    expect(isAdminPath('/admin')).toBe(true)
    expect(isAdminPath('/admin/accounts/x')).toBe(true)
    expect(isAdminPath('/administrator')).toBe(false)
    expect(isAdminPath('/dashboard/admin')).toBe(false)
  })

  it('writes a fresh nonce CSP with no unsafe-inline and nothing third-party', () => {
    const first = adminNonce()
    expect(first).toMatch(/^[A-Za-z0-9+/]{22}==$/)
    expect(adminNonce()).not.toBe(first)
    const csp = adminCsp(first, { supabaseHost: 'abc.supabase.co', development: false })
    expect(csp).toContain(`script-src 'self' 'nonce-${first}' 'strict-dynamic'`)
    expect(csp).not.toContain("unsafe-inline' https")
    expect(csp).not.toContain('challenges.cloudflare.com')
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("connect-src 'self' https://abc.supabase.co wss://abc.supabase.co")
    expect(adminCsp(first, { supabaseHost: 'x', development: true })).toContain("'unsafe-eval'")
    expect(adminHeaders(csp)).toEqual({
      'Content-Security-Policy': csp,
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'private, no-store',
    })
  })
})

describe('refusals in words', () => {
  it('words a raised code and a wrapper’s code alike, and falls back', () => {
    expect(bareAdminCode('admin:needs_code')).toBe('needs_code')
    expect(adminErrorWords('admin:test_admin')).toBe(ADMIN_ERROR_WORDS.test_admin)
    expect(adminErrorWords('SES_PAUSED')).toContain('AWS support case')
    expect(adminErrorWords('ses_paused')).toBe(ADMIN_ERROR_WORDS.SES_PAUSED)
    expect(adminErrorWords('SOMETHING_NEW')).toBe(FALLBACK_WORDS)
    expect(adminErrorWords(null)).toBe(FALLBACK_WORDS)
  })

  it('keeps the code a refusal came from, with an app code for its kind', () => {
    const refusal = new AdminRefusal('admin:needs_code')
    expect(refusal.adminCode).toBe('needs_code')
    expect(refusal.code).toBe('MFA_REQUIRED')
    expect(new AdminRefusal('ROLE').code).toBe('FORBIDDEN')
    expect(new AdminRefusal('CODE_RATE_LIMITED').code).toBe('RATE_LIMITED')
  })

  it('reads a wrapper’s answer, never trusting a shape it does not know', () => {
    expect(toAdminResult({ ok: true, auditId: 4, after: { state: 'active' } })).toEqual({
      ok: true,
      auditId: 4,
      after: { state: 'active' },
    })
    expect(toAdminResult({ ok: true, auditId: 4, replayed: true })).toEqual({
      ok: true,
      auditId: 4,
      replayed: true,
    })
    expect(toAdminResult({ ok: false, auditId: 5, code: 'NOT_SANDBOX' })).toEqual({
      ok: false,
      code: 'NOT_SANDBOX',
      message: ADMIN_ERROR_WORDS.NOT_SANDBOX,
      auditId: 5,
    })
    expect(toAdminResult({ ok: true })).toMatchObject({ ok: false, code: 'UNKNOWN' })
    expect(toAdminResult('nope')).toEqual({ ok: false, code: 'UNKNOWN', message: FALLBACK_WORDS })
  })

  it('tells a refusal from a lost answer, so the dialog keeps its key only for the second', () => {
    expect(adminOutcome({ data: { ok: true, auditId: 1 } })).toEqual({ ok: true, auditId: 1 })
    expect(adminOutcome({ serverError: 'Your admin role can’t' })).toEqual({
      ok: false,
      code: 'REFUSED',
      message: 'Your admin role can’t',
    })
    expect(adminOutcome({ serverError: SERVER_CRASH_WORDS })).toEqual({
      ok: false,
      code: UNKNOWN_OUTCOME,
      message: LOST_ANSWER_WORDS,
    })
    expect(adminOutcome({ validationErrors: { reason: { _errors: ['Give a reason'] } } })).toEqual({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'Give a reason',
    })
    expect(adminOutcome({ validationErrors: {} })).toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(adminOutcome(undefined)).toMatchObject({ code: UNKNOWN_OUTCOME })
  })

  it('shows only codes it has words for; anything else is a plain error, never its text', () => {
    expect(adminAccessError('admin:role')).toBeInstanceOf(AdminRefusal)
    expect(adminAccessError('NOT_FOUND')).toBeInstanceOf(AdminRefusal)
    const other = adminAccessError('relation "mail.x" does not exist')
    expect(other).not.toBeInstanceOf(AdminRefusal)
    expect(other.message).toBe(UNRECOGNISED_ADMIN_ERROR)
    expect(adminAccessError(undefined).message).toBe(UNRECOGNISED_ADMIN_ERROR)
  })
})

describe('words for what SQL answers', () => {
  it('writes rates from parts per million', () => {
    expect(formatPpm(43_000)).toBe('4.3%')
    expect(formatPpm(20_000)).toBe('2%')
    expect(formatPpm(523)).toBe('0.052%')
    expect(formatPpm(500)).toBe('0.05%')
    expect(formatPpm(5_000)).toBe('0.5%')
    expect(formatPpm(0)).toBe('0%')
    expect(formatPpm(null)).toBe('—')
  })

  it('writes counts, Lagos times and labels, and shows an unknown code as itself', () => {
    expect(formatCount(12_345)).toBe('12,345')
    expect(formatCount(null)).toBe('—')
    expect(formatWhen('2026-10-06T13:05:00Z')).toBe('6 Oct 2026, 14:05')
    expect(formatWhen('nonsense')).toBe('—')
    expect(formatWhen(null)).toBe('—')
    expect(stateOf('paused')).toEqual({ label: 'Paused', tone: 'danger' })
    expect(stateOf('weird')).toEqual({ label: 'weird', tone: 'neutral' })
    expect(sesStatusOf('disabled').label).toBe('Paused at SES')
    expect(sesStatusOf('odd').label).toBe('odd')
    expect(stateReasonOf('paused_bounce_rate')).toBe('Paused by our threshold: bounces')
    expect(stateReasonOf('custom')).toBe('custom')
    expect(stateReasonOf(null)).toBeNull()
    expect(findingKindOf('complaint_pause')).toBe('Complaints over our pause level')
    expect(findingKindOf('reputation_bounce_rate')).toBe('reputation bounce rate')
    expect(heartbeatLabel('mail-worker:send')).toBe('send')
  })
})

describe('the lists’ filters, from the address', () => {
  it('keeps only shapes it knows', () => {
    expect(pageOf({ page: '3' })).toBe(3)
    expect(pageOf({ page: ['2', '9'] })).toBe(2)
    expect(pageOf({ page: '0' })).toBe(1)
    expect(pageOf({ page: 'x' })).toBe(1)
    expect(accountStateOf({ state: 'paused' })).toBe('paused')
    expect(accountStateOf({ state: 'frozen' })).toBeNull()
    expect(domainStatusFilterOf({ status: 'verified' })).toBe('verified')
    expect(domainStatusFilterOf({})).toBeNull()
    expect(auditActionOf({ action: 'mail.resume' })).toBe('mail.resume')
    expect(auditActionOf({ action: 'refund.approve' })).toBeNull()
  })

  it('searches by tenant or account id only — never a name, which would sit in request logs', () => {
    expect(tenantQueryOf({ q: ' MDM-0123456789 ' })).toBe('mdm-0123456789')
    expect(tenantQueryOf({ q: '0123456789' })).toBe('mdm-0123456789')
    expect(tenantQueryOf({ q: 'Ada Lovelace' })).toBeNull()
    expect(tenantQueryOf({ q: 'ada@example.com' })).toBeNull()
  })

  it('builds addresses without the empty filters or the first page', () => {
    expect(listHref('/admin/accounts', { state: 'paused', q: null, page: 1 })).toBe(
      '/admin/accounts?state=paused',
    )
    expect(listHref('/admin/accounts', { state: null, page: 2 })).toBe('/admin/accounts?page=2')
    expect(listHref('/admin/audit', {})).toBe('/admin/audit')
  })
})
