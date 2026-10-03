import { revalidateTag } from 'next/cache'
import { headers } from 'next/headers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateFxRate,
  rejectFxRate,
  updatePricingSettings,
} from '@/features/admin/actions/pricing'
import {
  ADMIN_ERROR_WORDS,
  adminOutcome,
  SERVER_CRASH_WORDS,
  UNKNOWN_OUTCOME,
  WRONG_CODE_WORDS,
} from '@/features/admin/lib/errors'
import { createClient } from '@/lib/supabase/server'
import { sessionClient, whoami } from '../foundation/fixtures'
import { FRESH_ID } from './fixtures'

/**
 * The pricing actions (docs/ADMIN-SPEC.md §3.1.2, §5.2 B12), refusals first:
 * an operator or a test administrator is refused with the role's words
 * before any code is checked or SQL is asked; a wrong code reaches no
 * wrapper; input that does not validate reaches nothing; a wrapper's
 * refusal is worded and changes no price. Only then: one wrapper is called
 * with the session client, and the prices the site caches are expired.
 */

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('next/cache', () => ({ revalidateTag: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const KEY = '0f0e0d0c-0b0a-4908-8706-050403020100'
const REASON = 'The buffer no longer covers settlement'
const ROLE_WORDS = "Your admin role can't do this. Ask the owner."

type Rpc = Record<string, { data?: unknown; error?: { message: string } | null }>

function use(rpc: Rpc = {}, options: Parameters<typeof sessionClient>[0] = {}, who = {}) {
  const session = sessionClient({
    ...options,
    rpc: { admin_whoami: { data: whoami(who) }, ...rpc },
  })
  vi.mocked(createClient).mockResolvedValue(session.client as never)
  return session
}

const wrapperCalls = (session: ReturnType<typeof sessionClient>) =>
  session.rpc.mock.calls.filter(([name]) => name !== 'admin_whoami')

const save = (changes: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  updatePricingSettings({
    changes,
    reason: REASON,
    requestKey: KEY,
    code: '123456',
    ...extra,
  } as never)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(headers).mockResolvedValue(new Headers() as never)
})

describe('who may change prices', () => {
  const OPERATORS = [
    { role: 'operator', label: 'ops' },
    { role: 'viewer', label: 'viewer' },
    { role: 'operator', label: 'e2e-1', testOnly: true },
  ]

  it('refuses an operator, a viewer and a test administrator with the role’s words, before any code or wrapper', async () => {
    expect(ADMIN_ERROR_WORDS.ROLE).toBe(ROLE_WORDS)
    for (const who of OPERATORS) {
      for (const run of [
        () => save({ margin_ngn: 5000 }),
        () => activateFxRate({ rateId: FRESH_ID, reason: REASON, requestKey: KEY, code: '123456' }),
        () => rejectFxRate({ rateId: FRESH_ID, reason: REASON, requestKey: KEY, code: '123456' }),
      ]) {
        const session = use(
          {
            admin_update_pricing_settings: { data: { ok: true, auditId: 1 } },
            admin_activate_fx_rate: { data: { ok: true, auditId: 1 } },
            admin_reject_fx_rate: { data: { ok: true, auditId: 1 } },
          },
          {},
          who,
        )
        const answer = await run()
        expect(answer.serverError, who.label).toBe(ROLE_WORDS)
        expect(session.challengeAndVerify).not.toHaveBeenCalled()
        expect(wrapperCalls(session)).toEqual([])
        // Refused, not lost: the dialog takes a new request key.
        expect(adminOutcome(answer)).toMatchObject({ ok: false, code: 'REFUSED' })
      }
    }
    expect(revalidateTag).not.toHaveBeenCalled()
  })

  it('refuses a wrong code before SQL is asked anything', async () => {
    const session = use(
      { admin_update_pricing_settings: { data: { ok: true, auditId: 1 } } },
      {
        verify: {
          error: { message: 'Invalid TOTP code entered', code: 'mfa_verification_failed' },
        },
      },
    )
    const answer = await save({ margin_ngn: 5000 })
    expect(answer.serverError).toBe(WRONG_CODE_WORDS)
    expect(wrapperCalls(session)).toEqual([])
    expect(revalidateTag).not.toHaveBeenCalled()
  })
})

describe('updatePricingSettings', () => {
  it('validates before anything: VAT, an unknown key, a value out of range, no change, a short reason', async () => {
    use()
    for (const input of [
      { changes: { vat_pct: 5 } },
      { changes: { margin: 5000 } },
      { changes: { margin_ngn: 999 } },
      { changes: { margin_ngn: 5000.5 } },
      { changes: { fx_buffer_pct: 20.01 } },
      { changes: { fx_buffer_pct: 1.255 } },
      { changes: { icann_fee_cents: 201 } },
      { changes: { fx_move_threshold_pct: 0.5 } },
      { changes: {} },
      { changes: { margin_ngn: 5000 }, reason: 'too short' },
      { changes: { margin_ngn: 5000 }, code: '12345' },
      { changes: { margin_ngn: 5000 }, requestKey: 'again' },
    ]) {
      const answer = await save(input.changes, input)
      expect(answer.validationErrors, JSON.stringify(input)).toBeDefined()
    }
    expect(createClient).not.toHaveBeenCalled()
  })

  it("words the wrapper's refusal, and expires no price", async () => {
    use({
      admin_update_pricing_settings: { data: { ok: false, code: 'OUT_OF_RANGE', auditId: 7 } },
    })
    const answer = await save({ margin_ngn: 5000 })
    expect(answer.data).toEqual({
      ok: false,
      code: 'OUT_OF_RANGE',
      message: 'A value is outside what this setting allows.',
      auditId: 7,
    })
    expect(revalidateTag).not.toHaveBeenCalled()
  })

  it('treats an unexplained database error as an unknown outcome, so the key is kept', async () => {
    use({ admin_update_pricing_settings: { error: { message: 'fetch failed' } } })
    const answer = await save({ margin_ngn: 5000 })
    expect(answer.serverError).toBe(SERVER_CRASH_WORDS)
    expect(adminOutcome(answer)).toMatchObject({ ok: false, code: UNKNOWN_OUTCOME })
    expect(JSON.stringify(answer)).not.toContain('fetch failed')
    expect(revalidateTag).not.toHaveBeenCalled()
  })

  it('verifies the code, saves through the wrapper alone, then expires the site’s prices', async () => {
    const session = use({
      admin_update_pricing_settings: {
        data: { ok: true, auditId: 21, after: { margin_ngn: 5000, fx_move_threshold_pct: 7.25 } },
      },
    })
    const answer = await save({ margin_ngn: 5000, fx_move_threshold_pct: 7.25 })
    expect(session.challengeAndVerify).toHaveBeenCalledWith({
      factorId: whoami().factorId,
      code: '123456',
    })
    expect(session.rpc).toHaveBeenCalledWith('admin_whoami', { p_fresh_minutes: 5 })
    expect(wrapperCalls(session)).toEqual([
      [
        'admin_update_pricing_settings',
        {
          p_changes: { margin_ngn: 5000, fx_move_threshold_pct: 7.25 },
          p_reason: REASON,
          p_request_key: KEY,
        },
      ],
    ])
    expect(answer.data).toEqual({
      ok: true,
      auditId: 21,
      after: { margin_ngn: 5000, fx_move_threshold_pct: 7.25 },
    })
    expect(revalidateTag).toHaveBeenCalledWith('pricing', { expire: 0 })
  })
})

describe('activateFxRate', () => {
  it('words the wrapper’s refusals: too old, a newer rate active, no longer held', async () => {
    for (const [code, words] of [
      ['RATE_TOO_OLD', 'Too old to activate — the daily job will fetch a fresh one.'],
      ['NEWER_RATE_ACTIVE', 'A newer rate is already active. Reject this one.'],
      ['NOT_PENDING', 'This rate is no longer waiting for review.'],
      ['TEST_ADMIN', "Test administrators can't do this on live records."],
    ] as const) {
      use({ admin_activate_fx_rate: { data: { ok: false, code, auditId: 3 } } })
      const answer = await activateFxRate({
        rateId: FRESH_ID,
        reason: REASON,
        requestKey: KEY,
        code: '123456',
      })
      expect(answer.data).toEqual({ ok: false, code, message: words, auditId: 3 })
    }
    expect(revalidateTag).not.toHaveBeenCalled()
  })

  it('refuses a rate id that is not one before anything', async () => {
    use()
    const answer = await activateFxRate({
      rateId: 'latest',
      reason: REASON,
      requestKey: KEY,
      code: '123456',
    })
    expect(answer.validationErrors).toBeDefined()
    expect(createClient).not.toHaveBeenCalled()
  })

  it('activates through the wrapper, then expires the site’s prices', async () => {
    const session = use({
      admin_activate_fx_rate: { data: { ok: true, auditId: 30, after: { status: 'active' } } },
    })
    const answer = await activateFxRate({
      rateId: FRESH_ID,
      reason: REASON,
      requestKey: KEY,
      code: '123456',
    })
    expect(wrapperCalls(session)).toEqual([
      ['admin_activate_fx_rate', { p_rate_id: FRESH_ID, p_reason: REASON, p_request_key: KEY }],
    ])
    expect(answer.data).toEqual({ ok: true, auditId: 30, after: { status: 'active' } })
    expect(revalidateTag).toHaveBeenCalledWith('pricing', { expire: 0 })
  })

  it('expires the prices again on a replayed success', async () => {
    use({ admin_activate_fx_rate: { data: { ok: true, auditId: 30, replayed: true } } })
    const answer = await activateFxRate({
      rateId: FRESH_ID,
      reason: REASON,
      requestKey: KEY,
      code: '123456',
    })
    expect(answer.data).toEqual({ ok: true, auditId: 30, replayed: true })
    expect(revalidateTag).toHaveBeenCalledTimes(1)
  })
})

describe('rejectFxRate', () => {
  it('rejects through the wrapper and leaves the cached prices alone: they never read a held rate', async () => {
    const session = use({
      admin_reject_fx_rate: { data: { ok: true, auditId: 31, after: { status: 'rejected' } } },
    })
    const answer = await rejectFxRate({
      rateId: FRESH_ID,
      reason: REASON,
      requestKey: KEY,
      code: '123456',
    })
    expect(wrapperCalls(session)).toEqual([
      ['admin_reject_fx_rate', { p_rate_id: FRESH_ID, p_reason: REASON, p_request_key: KEY }],
    ])
    expect(answer.data).toEqual({ ok: true, auditId: 31, after: { status: 'rejected' } })
    expect(revalidateTag).not.toHaveBeenCalled()
  })

  it("words the wrapper's refusal", async () => {
    use({ admin_reject_fx_rate: { data: { ok: false, code: 'NOT_PENDING', auditId: 4 } } })
    const answer = await rejectFxRate({
      rateId: FRESH_ID,
      reason: REASON,
      requestKey: KEY,
      code: '123456',
    })
    expect(answer.data).toMatchObject({ ok: false, code: 'NOT_PENDING' })
  })
})
