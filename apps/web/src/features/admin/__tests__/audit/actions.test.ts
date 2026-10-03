import { headers } from 'next/headers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { redactAuditReason } from '@/features/admin/actions/audit'
import { ADMIN_ERROR_WORDS, adminOutcome, WRONG_CODE_WORDS } from '@/features/admin/lib/errors'
import { createClient } from '@/lib/supabase/server'
import { sessionClient, whoami } from '../foundation/fixtures'

/**
 * "Redact reason" (docs/ADMIN-SPEC.md §2.5, §5.2 B14), refusals first: an
 * operator and a test administrator are refused before SQL is asked, a
 * wrong code reaches no wrapper, and the owner's call goes to
 * `admin_redact_reason` — never to the table.
 */

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const KEY = '0f0e0d0c-0b0a-4908-8706-050403020100'
const WHY = 'The reason named the customer by email'
const input = { auditId: 412, why: WHY, requestKey: KEY, code: '123456' }

type Rpc = Record<string, { data?: unknown; error?: { message: string } | null }>

function use(
  who: Record<string, unknown>,
  rpc: Rpc = {},
  options: Parameters<typeof sessionClient>[0] = {},
) {
  const session = sessionClient({
    ...options,
    rpc: { admin_whoami: { data: whoami(who) }, ...rpc },
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

describe('redactAuditReason', () => {
  it('refuses an operator and a test administrator before any wrapper is called', async () => {
    for (const who of [
      { role: 'operator', label: 'ops' },
      { role: 'operator', label: 'e2e-1a2b3c4d', testOnly: true },
    ]) {
      const session = use(who, { admin_redact_reason: { data: { ok: true, auditId: 1 } } })
      const answer = await redactAuditReason(input)
      expect(answer.serverError, JSON.stringify(who)).toBe(ADMIN_ERROR_WORDS.ROLE)
      expect(wrapperCalls(session)).toEqual([])
    }
  })

  it('refuses a wrong code before SQL is asked anything', async () => {
    const session = use(
      { role: 'owner', label: 'owner' },
      { admin_redact_reason: { data: { ok: true, auditId: 1 } } },
      { verify: { error: { message: 'Invalid TOTP code', code: 'mfa_verification_failed' } } },
    )
    const answer = await redactAuditReason({ ...input, code: '000000' })
    expect(answer.serverError).toBe(WRONG_CODE_WORDS)
    expect(wrapperCalls(session)).toEqual([])
  })

  it('validates first: a short reason, no code or a bad id reach no session', async () => {
    const session = use({ role: 'owner', label: 'owner' })
    for (const bad of [
      { ...input, why: 'too short' },
      { ...input, code: '12345' },
      { ...input, auditId: -1 },
      { ...input, requestKey: 'again' },
    ]) {
      expect((await redactAuditReason(bad)).validationErrors, JSON.stringify(bad)).toBeDefined()
    }
    expect(createClient).not.toHaveBeenCalled()
    expect(session.challengeAndVerify).not.toHaveBeenCalled()
  })

  it('calls the wrapper for the owner, and words what it refuses', async () => {
    const session = use(
      { role: 'owner', label: 'owner' },
      { admin_redact_reason: { data: { ok: true, auditId: 900, after: { redacted: true } } } },
    )
    expect((await redactAuditReason(input)).data).toEqual({
      ok: true,
      auditId: 900,
      after: { redacted: true },
    })
    expect(wrapperCalls(session)).toEqual([
      ['admin_redact_reason', { p_audit_id: 412, p_why: WHY, p_request_key: KEY }],
    ])

    use(
      { role: 'owner', label: 'owner' },
      { admin_redact_reason: { data: { ok: false, code: 'NO_REASON', auditId: 901 } } },
    )
    expect((await redactAuditReason(input)).data).toEqual({
      ok: false,
      code: 'NO_REASON',
      message: 'That entry has no reason to remove.',
      auditId: 901,
    })
  })

  it('keeps the key when the answer is lost: the wrapper may have committed', async () => {
    use(
      { role: 'owner', label: 'owner' },
      { admin_redact_reason: { error: { message: 'fetch failed' } } },
    )
    expect(adminOutcome(await redactAuditReason(input))).toMatchObject({
      ok: false,
      code: 'UNKNOWN_OUTCOME',
    })
  })
})
