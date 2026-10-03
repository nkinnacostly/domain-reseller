import { headers } from 'next/headers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveIncident, resolveMoneyIncident } from '@/features/admin/actions/incidents'
import {
  approveRefund,
  cancelRefund,
  recordManualRefund,
  retryRefund,
} from '@/features/admin/actions/refunds'
import {
  adminOutcome,
  SERVER_CRASH_WORDS,
  UNKNOWN_OUTCOME,
  WRONG_CODE_WORDS,
} from '@/features/admin/lib/errors'
import { createClient } from '@/lib/supabase/server'
import { sessionClient, whoami } from '../foundation/fixtures'

/**
 * The refund and incident actions (ADMIN-SPEC §3.1.2, §5.2 B3), refusal
 * paths first: a wrong code, a role below the action, input that does not
 * validate and a wrapper's refusal all leave the refund as it was — and only
 * a wrapper is ever called, never a table.
 */

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const REFUND = '6f1d2c3b-4a59-4687-9a1b-2c3d4e5f6a7b'
const KEY = '0f0e0d0c-0b0a-4908-8706-050403020100'
const REASON = 'Checked the order: the domain was taken'

type Rpc = Record<string, { data?: unknown; error?: { message: string } | null }>

function use(rpc: Rpc = {}, options: Parameters<typeof sessionClient>[0] = {}) {
  const session = sessionClient({
    ...options,
    rpc: { admin_whoami: { data: whoami({ role: 'operator', label: 'ops' }) }, ...rpc },
  })
  vi.mocked(createClient).mockResolvedValue(session.client as never)
  return session
}

const wrapperCalls = (session: ReturnType<typeof sessionClient>) =>
  session.rpc.mock.calls.filter(([name]) => name !== 'admin_whoami')

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(headers).mockResolvedValue(new Headers() as never)
})

describe('approveRefund: refusals first', () => {
  it('refuses a wrong code before SQL is asked anything', async () => {
    const session = use(
      { admin_approve_refund: { data: { ok: true, auditId: 1 } } },
      {
        verify: {
          error: { message: 'Invalid TOTP code entered', code: 'mfa_verification_failed' },
        },
      },
    )
    const answer = await approveRefund({
      refundId: REFUND,
      reason: REASON,
      requestKey: KEY,
      code: '000000',
    })
    expect(answer.serverError).toBe(WRONG_CODE_WORDS)
    expect(wrapperCalls(session)).toEqual([])
    // A refused code is final for this key: the dialog takes a new one.
    expect(adminOutcome(answer)).toMatchObject({ ok: false, code: 'REFUSED' })
  })

  it('validates before anything: a short reason or a bad id reaches no session', async () => {
    const session = use()
    for (const input of [
      { refundId: REFUND, reason: 'too short', requestKey: KEY, code: '123456' },
      { refundId: 'not-an-id', reason: REASON, requestKey: KEY, code: '123456' },
      { refundId: REFUND, reason: REASON, requestKey: KEY, code: '12345' },
      { refundId: REFUND, reason: REASON, requestKey: 'again', code: '123456' },
    ]) {
      const answer = await approveRefund(input)
      expect(answer.validationErrors, JSON.stringify(input)).toBeDefined()
    }
    expect(createClient).not.toHaveBeenCalled()
    expect(session.challengeAndVerify).not.toHaveBeenCalled()
  })

  it("words the wrapper's refusal, and says nothing changed", async () => {
    use({ admin_approve_refund: { data: { ok: false, code: 'NOT_HELD', auditId: 9 } } })
    const answer = await approveRefund({
      refundId: REFUND,
      reason: REASON,
      requestKey: KEY,
      code: '123456',
    })
    expect(answer.data).toEqual({
      ok: false,
      code: 'NOT_HELD',
      message: 'This refund is no longer held. Reload the page to see where it is.',
      auditId: 9,
    })
  })

  it('treats an unexplained database error as an unknown outcome, so the key is kept', async () => {
    use({
      admin_approve_refund: { error: { message: 'canceling statement due to statement timeout' } },
    })
    const answer = await approveRefund({
      refundId: REFUND,
      reason: REASON,
      requestKey: KEY,
      code: '123456',
    })
    expect(answer.serverError).toBe(SERVER_CRASH_WORDS)
    expect(adminOutcome(answer)).toMatchObject({ ok: false, code: UNKNOWN_OUTCOME })
    expect(JSON.stringify(answer)).not.toContain('statement timeout')
  })

  it('verifies the code with this session factor, then approves through the wrapper', async () => {
    const session = use({
      admin_approve_refund: { data: { ok: true, auditId: 12, after: { status: 'queued' } } },
    })
    const answer = await approveRefund({
      refundId: REFUND,
      reason: REASON,
      requestKey: KEY,
      code: '123456',
    })
    expect(session.challengeAndVerify).toHaveBeenCalledWith({
      factorId: whoami().factorId,
      code: '123456',
    })
    expect(session.rpc).toHaveBeenCalledWith('admin_whoami', { p_fresh_minutes: 5 })
    expect(wrapperCalls(session)).toEqual([
      ['admin_approve_refund', { p_refund_id: REFUND, p_reason: REASON, p_request_key: KEY }],
    ])
    expect(answer.data).toEqual({ ok: true, auditId: 12, after: { status: 'queued' } })
  })

  it('passes a replay back as one', async () => {
    use({ admin_approve_refund: { data: { ok: true, auditId: 12, replayed: true } } })
    const answer = await approveRefund({
      refundId: REFUND,
      reason: REASON,
      requestKey: KEY,
      code: '123456',
    })
    expect(answer.data).toEqual({ ok: true, auditId: 12, replayed: true })
  })
})

describe('retryRefund', () => {
  it('sends whether the Flutterwave dashboard was checked; SQL refuses without it', async () => {
    const session = use({
      admin_retry_refund: { data: { ok: false, code: 'CHECK_PROVIDER', auditId: 3 } },
    })
    const answer = await retryRefund({
      refundId: REFUND,
      checkedProvider: false,
      reason: REASON,
      requestKey: KEY,
      code: '123456',
    })
    expect(wrapperCalls(session)).toEqual([
      [
        'admin_retry_refund',
        { p_refund_id: REFUND, p_checked_provider: false, p_reason: REASON, p_request_key: KEY },
      ],
    ])
    expect(answer.data).toMatchObject({ ok: false, code: 'CHECK_PROVIDER' })
  })
})

describe('cancelRefund (owner only)', () => {
  it('refuses an operator in words before the code is checked or SQL is asked to act', async () => {
    const session = use({ admin_cancel_refund: { data: { ok: true, auditId: 1 } } })
    const answer = await cancelRefund({
      refundId: REFUND,
      note: 'The bank reversed the charge',
      noMoneyMoved: true,
      checkedProvider: false,
      requestKey: KEY,
      code: '123456',
    })
    expect(answer.serverError).toBe("Your admin role can't do this. Ask the owner.")
    expect(session.challengeAndVerify).not.toHaveBeenCalled()
    expect(wrapperCalls(session)).toEqual([])
  })

  it('refuses a note over 300 characters before anything', async () => {
    use()
    const answer = await cancelRefund({
      refundId: REFUND,
      note: 'x'.repeat(301),
      noMoneyMoved: true,
      checkedProvider: false,
      requestKey: KEY,
      code: '123456',
    })
    expect(answer.validationErrors).toBeDefined()
    expect(createClient).not.toHaveBeenCalled()
  })

  it('cancels for the owner with the note and both confirmations', async () => {
    const session = sessionClient({
      rpc: {
        admin_whoami: { data: whoami() },
        admin_cancel_refund: { data: { ok: true, auditId: 4 } },
      },
    })
    vi.mocked(createClient).mockResolvedValue(session.client as never)
    const answer = await cancelRefund({
      refundId: REFUND,
      note: '  The bank reversed the charge  ',
      noMoneyMoved: true,
      checkedProvider: true,
      requestKey: KEY,
      code: '123456',
    })
    expect(wrapperCalls(session)).toEqual([
      [
        'admin_cancel_refund',
        {
          p_refund_id: REFUND,
          p_no_money_moved: true,
          p_checked_provider: true,
          p_note: 'The bank reversed the charge',
          p_request_key: KEY,
        },
      ],
    ])
    expect(answer.data).toEqual({ ok: true, auditId: 4 })
  })
})

describe('recordManualRefund', () => {
  it("refuses a reference that isn't a Flutterwave refund id", async () => {
    use()
    const answer = await recordManualRefund({
      refundId: REFUND,
      checkId: 7,
      flwRefundId: 'no spaces!',
      checkedProvider: false,
      reason: REASON,
      requestKey: KEY,
      code: '123456',
    })
    expect(answer.validationErrors).toBeDefined()
    expect(createClient).not.toHaveBeenCalled()
  })

  it('records against the check the gateway stored; SQL holds it to this charge and amount', async () => {
    const session = use({
      admin_record_manual_refund: { data: { ok: false, code: 'FLW_NOT_VERIFIED', auditId: 5 } },
    })
    const answer = await recordManualRefund({
      refundId: REFUND,
      checkId: 7,
      flwRefundId: 'RF-123',
      checkedProvider: true,
      reason: REASON,
      requestKey: KEY,
      code: '123456',
    })
    expect(wrapperCalls(session)).toEqual([
      [
        'admin_record_manual_refund',
        {
          p_refund_id: REFUND,
          p_check_id: 7,
          p_provider_refund_id: 'RF-123',
          p_checked_provider: true,
          p_reason: REASON,
          p_request_key: KEY,
        },
      ],
    ])
    expect(answer.data).toMatchObject({ ok: false, code: 'FLW_NOT_VERIFIED' })
  })
})

describe('resolving an incident', () => {
  it('records a look at an incident where nothing is owed, with no code and no evidence', async () => {
    const session = use({ admin_resolve_payment_incident: { data: { ok: true, auditId: 6 } } })
    const answer = await resolveIncident({ incidentId: 42, reason: REASON, requestKey: KEY })
    expect(session.challengeAndVerify).not.toHaveBeenCalled()
    expect(wrapperCalls(session)).toEqual([
      [
        'admin_resolve_payment_incident',
        {
          p_incident_id: 42,
          p_outcome: 'reviewed',
          p_refund_id: null,
          p_check_id: null,
          p_confirmed: false,
          p_reason: REASON,
          p_request_key: KEY,
        },
      ],
    ])
    expect(answer.data).toEqual({ ok: true, auditId: 6 })
  })

  it('needs the refund that completed, or the check, before anything', async () => {
    use()
    const base = {
      incidentId: 42,
      confirmed: false,
      reason: REASON,
      requestKey: KEY,
      code: '123456',
    }
    expect(
      (await resolveMoneyIncident({ ...base, outcome: 'refund_completed' })).validationErrors,
    ).toBeDefined()
    expect(
      (await resolveMoneyIncident({ ...base, outcome: 'flw_refund_verified' })).validationErrors,
    ).toBeDefined()
    expect(createClient).not.toHaveBeenCalled()
  })

  it('sends only the evidence its outcome uses', async () => {
    const session = use({
      admin_resolve_payment_incident: { data: { ok: false, code: 'OUTCOME_NOT_MET', auditId: 8 } },
    })
    const answer = await resolveMoneyIncident({
      incidentId: 42,
      outcome: 'flw_refund_verified',
      refundId: REFUND,
      checkId: 7,
      confirmed: true,
      reason: REASON,
      requestKey: KEY,
      code: '123456',
    })
    expect(wrapperCalls(session)).toEqual([
      [
        'admin_resolve_payment_incident',
        {
          p_incident_id: 42,
          p_outcome: 'flw_refund_verified',
          p_refund_id: null,
          p_check_id: 7,
          p_confirmed: false,
          p_reason: REASON,
          p_request_key: KEY,
        },
      ],
    ])
    expect(answer.data).toMatchObject({
      ok: false,
      code: 'OUTCOME_NOT_MET',
      message: "What you chose isn't shown by the records yet. Check it, then try again.",
    })
  })

  it('passes the refund for a completed refund, and the confirmation for outside handling', async () => {
    const session = use({ admin_resolve_payment_incident: { data: { ok: true, auditId: 10 } } })
    await resolveMoneyIncident({
      incidentId: 42,
      outcome: 'refund_completed',
      refundId: REFUND,
      confirmed: false,
      reason: REASON,
      requestKey: KEY,
      code: '123456',
    })
    await resolveMoneyIncident({
      incidentId: 42,
      outcome: 'handled_outside',
      confirmed: true,
      reason: REASON,
      requestKey: KEY,
      code: '123456',
    })
    const [first, second] = wrapperCalls(session).map(([, args]) => args)
    expect(first).toMatchObject({
      p_outcome: 'refund_completed',
      p_refund_id: REFUND,
      p_check_id: null,
    })
    expect(second).toMatchObject({
      p_outcome: 'handled_outside',
      p_confirmed: true,
      p_refund_id: null,
    })
  })
})
