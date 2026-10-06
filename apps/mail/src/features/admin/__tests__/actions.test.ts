import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { ADMIN_ERROR_WORDS, SERVER_CRASH_WORDS } from '../lib/errors'
import { ACCOUNT, fakeAdmin, whoami } from './fake-admin'

/**
 * Mail's admin actions (MAIL-SPEC §10, MR5): input first, then the admin in
 * SQL, then — for resume and caps — the dialog's code against this session's
 * factor; each calls one audited admin_mail_* wrapper on public, and a pause
 * or resume then applies SES's side straight away.
 */

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('@/features/safety/queries/apply', () => ({ applyDueTenantActions: vi.fn() }))

const { adminAction, adminMoneyAction, codeRefusal } = await import('../lib/action-client')
const { approveAccount, overrideCaps, pauseAccount, rejectAccount, resumeAccount } = await import(
  '../actions/accounts'
)
const { applyDueTenantActions } = await import('@/features/safety/queries/apply')

const KEY = '8dbd7ea2-c535-4a4a-a091-e202d9185a20'
const reason = 'A reason of ten or more characters'

function use(
  wrappers: Record<
    string,
    (args: Record<string, unknown>) => { data: unknown; error: unknown }
  > = {},
  options: {
    role?: string
    testOnly?: boolean
    verify?: { error: unknown }
    user?: { id: string } | null
  } = {},
) {
  const fake = fakeAdmin({
    user: options.user === undefined ? { id: 'admin-user' } : options.user,
    verify: options.verify ?? { error: null },
    rpc: {
      admin_whoami: () => ({
        data: whoami({ role: options.role ?? 'owner', testOnly: options.testOnly ?? false }),
        error: null,
      }),
      ...wrappers,
    },
  })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}

const ok =
  (after: Record<string, unknown> = {}) =>
  () => ({ data: { ok: true, auditId: 9, after }, error: null })

beforeEach(() => vi.clearAllMocks())

describe('the action clients', () => {
  it('refuse to build a money action as a standard one, and the other way round', () => {
    expect(() => adminAction('mail.resume', z.object({}))).toThrow(
      'money action mail.resume on adminAction',
    )
    expect(() => adminMoneyAction('mail.approve', z.object({ code: z.string() }))).toThrow(
      'standard action mail.approve on adminMoneyAction',
    )
  })

  it('validate the input before anything reaches SQL', async () => {
    const fake = use({ admin_mail_approve_account: ok() })
    const answer = await approveAccount({ accountId: 'nope', reason: 'short', requestKey: KEY })
    expect(answer?.validationErrors).toBeTruthy()
    expect(fake.calls).toEqual([])
  })

  it('need someone signed in, and an admin SQL knows, of a role that may act', async () => {
    use({}, { user: null })
    expect(
      (await approveAccount({ accountId: ACCOUNT, reason, requestKey: KEY }))?.serverError,
    ).toBe('Please sign in to continue.')
    const viewer = use({ admin_mail_approve_account: ok() }, { role: 'viewer' })
    expect(
      (await approveAccount({ accountId: ACCOUNT, reason, requestKey: KEY }))?.serverError,
    ).toBe(ADMIN_ERROR_WORDS.role)
    expect(viewer.calls.map((c) => c.fn)).toEqual(['admin_whoami'])
    const stranger = fakeAdmin({
      rpc: { admin_whoami: () => ({ data: null, error: { message: 'admin:not_admin' } }) },
    })
    vi.mocked(createClient).mockResolvedValue(stranger.client as never)
    expect(
      (await approveAccount({ accountId: ACCOUNT, reason, requestKey: KEY }))?.serverError,
    ).toBe(ADMIN_ERROR_WORDS.not_admin)
  })

  it('word a wrong, rate-limited or unchecked code, none of which reached a wrapper', () => {
    expect(codeRefusal({ code: 'mfa_verification_failed' }).adminCode).toBe('WRONG_CODE')
    expect(codeRefusal({ code: 'mfa_challenge_expired' }).adminCode).toBe('WRONG_CODE')
    expect(codeRefusal({ status: 429 }).adminCode).toBe('CODE_RATE_LIMITED')
    expect(codeRefusal({ code: 'over_request_rate_limit' }).adminCode).toBe('CODE_RATE_LIMITED')
    expect(codeRefusal({}).adminCode).toBe('CODE_NOT_CHECKED')
  })
})

describe('approve and reject (§7.2)', () => {
  it('call their wrapper with the reason and the key, and answer what it answered', async () => {
    const fake = use({
      admin_mail_approve_account: ok({ state: 'active' }),
      admin_mail_reject_account: ok(),
    })
    expect((await approveAccount({ accountId: ACCOUNT, reason, requestKey: KEY }))?.data).toEqual({
      ok: true,
      auditId: 9,
      after: { state: 'active' },
    })
    await rejectAccount({ accountId: ACCOUNT, reason, requestKey: KEY })
    expect(fake.calls.filter((c) => c.fn.startsWith('admin_mail_'))).toEqual([
      {
        schema: 'public',
        fn: 'admin_mail_approve_account',
        args: { p_account_id: ACCOUNT, p_reason: reason, p_request_key: KEY },
      },
      {
        schema: 'public',
        fn: 'admin_mail_reject_account',
        args: { p_account_id: ACCOUNT, p_reason: reason, p_request_key: KEY },
      },
    ])
    expect(applyDueTenantActions).not.toHaveBeenCalled()
  })

  it('answer a recorded refusal in words', async () => {
    use({
      admin_mail_approve_account: () => ({
        data: { ok: false, auditId: 3, code: 'NO_VERIFIED_DOMAIN' },
        error: null,
      }),
    })
    expect((await approveAccount({ accountId: ACCOUNT, reason, requestKey: KEY }))?.data).toEqual({
      ok: false,
      code: 'NO_VERIFIED_DOMAIN',
      message: ADMIN_ERROR_WORDS.NO_VERIFIED_DOMAIN,
      auditId: 3,
    })
  })

  it('never show a database’s own words: a call that failed may have gone through', async () => {
    use({
      admin_mail_reject_account: () => ({
        data: null,
        error: { message: 'connection reset by peer' },
      }),
    })
    expect(
      (await rejectAccount({ accountId: ACCOUNT, reason, requestKey: KEY }))?.serverError,
    ).toBe(SERVER_CRASH_WORDS)
  })
})

describe('pause and resume (§7.4, MR5)', () => {
  it('applies SES’s side straight after a pause that asked for it, and not otherwise', async () => {
    use({ admin_mail_pause_account: ok({ state: 'paused', tenantActionId: 4 }) })
    await pauseAccount({ accountId: ACCOUNT, reason, requestKey: KEY })
    expect(applyDueTenantActions).toHaveBeenCalledTimes(1)
    vi.mocked(applyDueTenantActions).mockClear()
    use({ admin_mail_pause_account: ok({ state: 'paused', tenantActionId: null }) })
    await pauseAccount({ accountId: ACCOUNT, reason, requestKey: KEY })
    expect(applyDueTenantActions).not.toHaveBeenCalled()
  })

  it('keeps the pause when SES’s side fails now: it waits, queued', async () => {
    vi.mocked(applyDueTenantActions).mockRejectedValueOnce(new Error('claim failed'))
    use({ admin_mail_pause_account: ok({ tenantActionId: 4 }) })
    expect(
      (await pauseAccount({ accountId: ACCOUNT, reason, requestKey: KEY }))?.data,
    ).toMatchObject({ ok: true })
  })

  it('resumes only with a code checked against this session’s factor, then a 5-minute session', async () => {
    const fake = use({ admin_mail_resume_account: ok({ state: 'active', tenantActionId: 8 }) })
    const answer = await resumeAccount({
      accountId: ACCOUNT,
      findingId: 12,
      reason,
      requestKey: KEY,
      code: '123456',
    })
    expect(answer?.data).toMatchObject({ ok: true })
    expect(fake.challengeAndVerify).toHaveBeenCalledWith({
      factorId: whoami().factorId,
      code: '123456',
    })
    expect(fake.calls.filter((c) => c.fn === 'admin_whoami').map((c) => c.args)).toEqual([
      {},
      { p_fresh_minutes: 5 },
    ])
    expect(fake.calls.find((c) => c.fn === 'admin_mail_resume_account')?.args).toEqual({
      p_account_id: ACCOUNT,
      p_finding_id: 12,
      p_reason: reason,
      p_request_key: KEY,
    })
    expect(applyDueTenantActions).toHaveBeenCalledTimes(1)
  })

  it('reaches no wrapper with a wrong code, or for an operator', async () => {
    const wrong = use(
      { admin_mail_resume_account: ok() },
      { verify: { error: { code: 'mfa_verification_failed' } } },
    )
    expect(
      (
        await resumeAccount({
          accountId: ACCOUNT,
          findingId: null,
          reason,
          requestKey: KEY,
          code: '000000',
        })
      )?.serverError,
    ).toBe(ADMIN_ERROR_WORDS.WRONG_CODE)
    expect(wrong.calls.some((c) => c.fn === 'admin_mail_resume_account')).toBe(false)
    const operator = use({ admin_mail_resume_account: ok() }, { role: 'operator' })
    expect(
      (
        await resumeAccount({
          accountId: ACCOUNT,
          findingId: 1,
          reason,
          requestKey: KEY,
          code: '123456',
        })
      )?.serverError,
    ).toBe(ADMIN_ERROR_WORDS.role)
    expect(operator.challengeAndVerify).not.toHaveBeenCalled()
  })
})

describe('cap overrides (§10)', () => {
  it('sends both caps, a null keeping the plan’s, after the code', async () => {
    const fake = use({ admin_mail_override_caps: ok({ dailyCap: 500, monthlyCap: null }) })
    await overrideCaps({
      accountId: ACCOUNT,
      dailyCap: 500,
      monthlyCap: null,
      reason,
      requestKey: KEY,
      code: '654321',
    })
    expect(fake.calls.find((c) => c.fn === 'admin_mail_override_caps')?.args).toEqual({
      p_account_id: ACCOUNT,
      p_daily_cap: 500,
      p_monthly_cap: null,
      p_reason: reason,
      p_request_key: KEY,
    })
    expect(
      (
        await overrideCaps({
          accountId: ACCOUNT,
          dailyCap: 0,
          monthlyCap: null,
          reason,
          requestKey: KEY,
          code: '654321',
        })
      )?.validationErrors,
    ).toBeTruthy()
  })
})
