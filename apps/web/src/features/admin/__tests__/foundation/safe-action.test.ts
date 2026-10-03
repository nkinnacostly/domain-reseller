import { cookies, headers } from 'next/headers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { switchAdminSide } from '@/features/admin/actions/side'
import {
  adminOutcome,
  CODE_NOT_CHECKED_WORDS,
  CODE_RATE_LIMITED_WORDS,
  NEEDS_CODE_WORDS,
  SERVER_CRASH_WORDS,
  UNKNOWN_OUTCOME,
  WRONG_CODE_WORDS,
} from '@/features/admin/lib/errors'
import { SIDE_COOKIE } from '@/features/admin/lib/side'
import { adminAction, adminMoneyAction } from '@/lib/safe-action'
import { createClient } from '@/lib/supabase/server'
import { sessionClient, whoami } from './fixtures'

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const REQUEST_ID = '0f0e0d0c-0b0a-4908-8706-050403020100'

function use(session: ReturnType<typeof sessionClient>) {
  vi.mocked(createClient).mockResolvedValue(session.client as never)
  return session
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(headers).mockResolvedValue(new Headers({ 'x-request-id': REQUEST_ID }) as never)
})

describe('adminAction (ADMIN-SPEC §2.4)', () => {
  const schema = z.object({ emailId: z.uuid() })
  const body = vi.fn(async () => ({ ok: true as const, auditId: 1 }))
  const requeue = adminAction('email.requeue', schema).action(async ({ ctx }) => {
    await body()
    return { label: ctx.admin.label, action: ctx.action }
  })

  it('validates the input before anything else: no session, no note, no rpc', async () => {
    const session = use(sessionClient({ rpc: { admin_whoami: { data: whoami() } } }))
    const result = await requeue({ emailId: 'not-a-uuid' } as never)

    expect(result.validationErrors).toBeDefined()
    expect(createClient).not.toHaveBeenCalled()
    expect(session.rpc).not.toHaveBeenCalled()
    expect(body).not.toHaveBeenCalled()
  })

  it('hands the body the admin from SQL, never from a claim', async () => {
    const session = use(
      sessionClient({
        rpc: { admin_whoami: { data: whoami({ role: 'operator', label: 'ops' }) } },
      }),
    )
    const result = await requeue({ emailId: REQUEST_ID })

    expect(result.data).toEqual({ label: 'ops', action: 'email.requeue' })
    expect(session.rpc).toHaveBeenCalledWith('admin_whoami', {})
  })

  it('sends the request id with the session client, so the audit row can be joined to logs', async () => {
    use(sessionClient({ rpc: { admin_whoami: { data: whoami() } } }))
    await requeue({ emailId: REQUEST_ID })
    expect(createClient).toHaveBeenCalledWith({ requestId: REQUEST_ID })
  })

  it('makes up a uuid when the platform sent a request id that is not one', async () => {
    vi.mocked(headers).mockResolvedValue(new Headers({ 'x-request-id': 'req-42' }) as never)
    use(sessionClient({ rpc: { admin_whoami: { data: whoami() } } }))
    await requeue({ emailId: REQUEST_ID })
    const [options] = vi.mocked(createClient).mock.calls[0] ?? []
    expect(options?.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(options?.requestId).not.toBe('req-42')
  })

  it("asks for a code in words when the gate says the session's code is stale", async () => {
    use(sessionClient({ rpc: { admin_whoami: { error: { message: 'admin:needs_code' } } } }))
    expect(await requeue({ emailId: REQUEST_ID })).toEqual({ serverError: NEEDS_CODE_WORDS })
    expect(body).not.toHaveBeenCalled()
  })

  it.each([
    ['admin:not_admin', 'This needs an administrator.'],
    ['admin:weak_sign_in', /A sign-in link can't open the admin area/],
    ['admin:factor_mismatch', /isn't linked to your admin access/],
    // Not an admin code: it may not be a refusal, so it is not worded as one.
    ['relation "admins" does not exist', SERVER_CRASH_WORDS],
  ])('words the refusal %s without showing the database', async (message, words) => {
    use(sessionClient({ rpc: { admin_whoami: { error: { message } } } }))
    const result = await requeue({ emailId: REQUEST_ID })
    if (typeof words === 'string') expect(result.serverError).toBe(words)
    else expect(result.serverError).toMatch(words)
    expect(JSON.stringify(result)).not.toContain('relation')
  })

  it('refuses a role below the action in words before SQL is asked to act', async () => {
    use(sessionClient({ rpc: { admin_whoami: { data: whoami({ role: 'viewer' }) } } }))
    expect(await requeue({ emailId: REQUEST_ID })).toEqual({
      serverError: "Your admin role can't do this. Ask the owner.",
    })
    expect(body).not.toHaveBeenCalled()
  })

  it('refuses a signed-out visitor', async () => {
    use(sessionClient({ user: null }))
    expect(await requeue({ emailId: REQUEST_ID })).toEqual({
      serverError: 'Please sign in to continue.',
    })
  })

  it('treats an answer of the wrong shape as no admin', async () => {
    use(sessionClient({ rpc: { admin_whoami: { data: { userId: 'x' } } } }))
    expect(await requeue({ emailId: REQUEST_ID })).toEqual({
      serverError: 'This needs an administrator.',
    })
  })

  it('will not build a money action without the code step', () => {
    expect(() => adminAction('refund.approve', schema)).toThrow(/money action/)
  })
})

describe('adminMoneyAction (D6)', () => {
  const schema = z.object({ refundId: z.uuid(), code: z.string() })
  const body = vi.fn(async () => ({ ok: true as const, auditId: 7 }))
  const approve = adminMoneyAction('refund.approve', schema).action(async ({ ctx }) => {
    await body()
    return { codeAt: ctx.admin.codeAt }
  })

  it("verifies the dialog's code with this session's own factor, then asks SQL for a five-minute-fresh code", async () => {
    const fresh = whoami({ codeAt: '2026-10-03T10:00:00.000Z' })
    const session = use(
      sessionClient({ rpc: { admin_whoami: [{ data: whoami() }, { data: fresh }] } }),
    )
    const result = await approve({ refundId: REQUEST_ID, code: '123456' })

    expect(session.challengeAndVerify).toHaveBeenCalledWith({
      factorId: '99999999-8888-4777-8666-555555555555',
      code: '123456',
    })
    expect(session.rpc).toHaveBeenNthCalledWith(1, 'admin_whoami', {})
    expect(session.rpc).toHaveBeenNthCalledWith(2, 'admin_whoami', { p_fresh_minutes: 5 })
    expect(result.data).toEqual({ codeAt: '2026-10-03T10:00:00.000Z' })
    expect(body).toHaveBeenCalledTimes(1)
  })

  it.each(['mfa_verification_failed', 'mfa_challenge_expired'])(
    'refuses a wrong code (%s) in words, and nothing reaches a wrapper',
    async (code) => {
      const session = use(
        sessionClient({
          rpc: { admin_whoami: { data: whoami() } },
          verify: { error: { message: 'Invalid TOTP code entered', code } },
        }),
      )
      const result = await approve({ refundId: REQUEST_ID, code: '000000' })

      expect(result).toEqual({ serverError: WRONG_CODE_WORDS })
      expect(adminOutcome({ serverError: result.serverError })).toMatchObject({ code: 'REFUSED' })
      expect(session.rpc).toHaveBeenCalledTimes(1)
      expect(session.rpc).toHaveBeenCalledWith('admin_whoami', {})
      expect(body).not.toHaveBeenCalled()
    },
  )

  it.each([
    [
      'a rate limit by code',
      { message: 'Too many requests', code: 'over_request_rate_limit', status: 429 },
      CODE_RATE_LIMITED_WORDS,
    ],
    [
      'a rate limit by status alone',
      { message: 'Too many requests', status: 429 },
      CODE_RATE_LIMITED_WORDS,
    ],
    ['a failed request', { message: 'TypeError: fetch failed', status: 0 }, CODE_NOT_CHECKED_WORDS],
    ['an auth server error', { message: 'Internal error', status: 500 }, CODE_NOT_CHECKED_WORDS],
    [
      'a factor Auth no longer knows',
      { message: 'Factor not found', code: 'mfa_factor_not_found', status: 404 },
      CODE_NOT_CHECKED_WORDS,
    ],
  ])(
    "says %s in its own words, never the person's code: nothing reached a wrapper",
    async (_, error, words) => {
      const session = use(
        sessionClient({ rpc: { admin_whoami: { data: whoami() } }, verify: { error } }),
      )
      const result = await approve({ refundId: REQUEST_ID, code: '123456' })

      expect(result).toEqual({ serverError: words })
      expect(words).not.toBe(WRONG_CODE_WORDS)
      // Known: nothing changed, so a refusal (a new key), not an unknown outcome.
      expect(adminOutcome({ serverError: result.serverError })).toMatchObject({
        ok: false,
        code: 'REFUSED',
      })
      expect(session.rpc).toHaveBeenCalledTimes(1)
      expect(body).not.toHaveBeenCalled()
    },
  )

  it('words a rate limit apart from a failed request', () => {
    expect(CODE_RATE_LIMITED_WORDS).not.toBe(CODE_NOT_CHECKED_WORDS)
    expect(CODE_RATE_LIMITED_WORDS).toMatch(/nothing changed/)
    expect(CODE_NOT_CHECKED_WORDS).toMatch(/nothing changed/)
  })

  it.each(['email.requeue', 'supplier.balance', 'customer.reveal'] as const)(
    'will not build a standard action (%s), which would demand a code it does not need',
    (action) => {
      expect(() => adminMoneyAction(action, schema)).toThrow(/standard action/)
    },
  )

  it('refuses a code that is not six digits before any call', async () => {
    const session = use(sessionClient({ rpc: { admin_whoami: { data: whoami() } } }))
    const result = await approve({ refundId: REQUEST_ID, code: '12ab' })

    expect(result).toEqual({ serverError: WRONG_CODE_WORDS })
    expect(session.rpc).not.toHaveBeenCalled()
    expect(session.challengeAndVerify).not.toHaveBeenCalled()
    expect(body).not.toHaveBeenCalled()
  })

  it('stops when SQL refuses the second, five-minute whoami after a verified code', async () => {
    // The code verified, but SQL does not see a fresh one (a clock or session
    // refresh problem): no wrapper runs, and the words ask for a code again.
    const session = use(
      sessionClient({
        rpc: { admin_whoami: [{ data: whoami() }, { error: { message: 'admin:needs_code' } }] },
      }),
    )
    const result = await approve({ refundId: REQUEST_ID, code: '123456' })

    expect(session.challengeAndVerify).toHaveBeenCalledTimes(1)
    expect(session.rpc).toHaveBeenNthCalledWith(2, 'admin_whoami', { p_fresh_minutes: 5 })
    expect(result).toEqual({ serverError: NEEDS_CODE_WORDS })
    expect(body).not.toHaveBeenCalled()
  })

  it('calls a transport failure on the second whoami an unknown outcome, not a refusal', async () => {
    use(
      sessionClient({
        rpc: {
          admin_whoami: [{ data: whoami() }, { error: { message: 'TypeError: fetch failed' } }],
        },
      }),
    )
    const result = await approve({ refundId: REQUEST_ID, code: '123456' })

    expect(result).toEqual({ serverError: SERVER_CRASH_WORDS })
    expect(adminOutcome({ serverError: result.serverError })).toMatchObject({
      ok: false,
      code: UNKNOWN_OUTCOME,
    })
    expect(body).not.toHaveBeenCalled()
  })

  it('checks the role before it verifies a code', async () => {
    const session = use(
      sessionClient({ rpc: { admin_whoami: { data: whoami({ role: 'viewer' }) } } }),
    )
    const result = await approve({ refundId: REQUEST_ID, code: '123456' })

    expect(result).toEqual({ serverError: "Your admin role can't do this. Ask the owner." })
    expect(session.challengeAndVerify).not.toHaveBeenCalled()
  })
})

describe('switchAdminSide', () => {
  function cookieJar() {
    const set = vi.fn()
    vi.mocked(cookies).mockResolvedValue({ set, get: vi.fn() } as never)
    return set
  }

  it('lets any admin switch, viewers included, and is not audited', async () => {
    const set = cookieJar()
    const session = use(
      sessionClient({ rpc: { admin_whoami: { data: whoami({ role: 'viewer' }) } } }),
    )

    expect(await switchAdminSide({ side: 'test' })).toEqual({ data: { ok: true, side: 'test' } })
    expect(set).toHaveBeenCalledWith(
      SIDE_COOKIE,
      'test',
      expect.objectContaining({ httpOnly: true, path: '/admin' }),
    )
    expect(session.rpc).toHaveBeenCalledTimes(1)
  })

  it('keeps a test administrator on the test side', async () => {
    const set = cookieJar()
    use(sessionClient({ rpc: { admin_whoami: { data: whoami({ testOnly: true }) } } }))

    expect(await switchAdminSide({ side: 'live' })).toEqual({ data: { ok: true, side: 'test' } })
    expect(set).toHaveBeenCalledWith(SIDE_COOKIE, 'test', expect.anything())
  })

  it('refuses a side it does not know', async () => {
    cookieJar()
    use(sessionClient({ rpc: { admin_whoami: { data: whoami() } } }))
    expect((await switchAdminSide({ side: 'staging' } as never)).validationErrors).toBeDefined()
  })
})
