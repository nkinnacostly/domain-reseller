import { headers } from 'next/headers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { findCustomers, revealCustomer } from '@/features/admin/actions/customers'
import { adminOutcome, SERVER_CRASH_WORDS, UNKNOWN_OUTCOME } from '@/features/admin/lib/errors'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'
import { sessionClient, whoami } from '../foundation/fixtures'
import { ids } from './fake-db'

/**
 * Customer search and reveal (ADMIN-SPEC §3.1.2, §5.2 B8), refusals first:
 * input that does not validate reaches no session, a viewer is refused
 * before SQL, and the limit's and the gate's refusals come back in words.
 * Only the admin_* functions are called, and nothing typed or shown is
 * logged (N13).
 */

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const EMAIL = 'someone@example.ng'

type Rpc = Record<string, { data?: unknown; error?: { message: string } | null }>

function use(rpc: Rpc = {}, role = 'operator') {
  const session = sessionClient({
    rpc: { admin_whoami: { data: whoami({ role, label: 'ops' }) }, ...rpc },
  })
  vi.mocked(createClient).mockResolvedValue(session.client as never)
  return session
}

const calls = (session: ReturnType<typeof sessionClient>) =>
  session.rpc.mock.calls.filter(([name]) => name !== 'admin_whoami')

/** Every logger call's arguments, as one string, to look for what must never be there. */
function logged(): string {
  return JSON.stringify(
    (['info', 'warn', 'error', 'debug'] as const).flatMap((level) =>
      vi.mocked(logger[level]).mock.calls.map((call) => call),
    ),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(headers).mockResolvedValue(new Headers() as never)
  for (const level of ['info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(logger, level).mockImplementation(() => undefined as never)
  }
})

describe('findCustomers: refusals first', () => {
  it('validates before anything: too short, too long or no query reaches no session', async () => {
    const session = use()
    for (const query of ['ab', '  a ', 'x'.repeat(255)]) {
      const answer = await findCustomers({ query })
      expect(answer.validationErrors, query).toBeDefined()
    }
    expect(session.rpc).not.toHaveBeenCalled()
  })

  it('refuses a viewer before SQL is asked to search', async () => {
    const session = use(
      { admin_find_customers: { data: { ok: true, auditId: 1, rows: [] } } },
      'viewer',
    )
    const answer = await findCustomers({ query: EMAIL })
    expect(answer.serverError).toBe("Your admin role can't do this. Ask the owner.")
    expect(calls(session)).toEqual([])
  })

  it('says so when the hour’s searches are used up', async () => {
    use({
      admin_find_customers: { data: { ok: false, auditId: 4, code: 'RATE_LIMITED' } },
    })
    const answer = await findCustomers({ query: EMAIL })
    expect(answer.data).toEqual({
      ok: false,
      code: 'RATE_LIMITED',
      message: "You've looked up a lot of customers this hour. Wait, or ask the owner.",
      auditId: 4,
    })
  })

  it('words a gate raise, and keeps an error it does not know from the page (N10)', async () => {
    use({ admin_find_customers: { error: { message: 'admin:needs_code' } } })
    const refused = await findCustomers({ query: EMAIL })
    expect(refused.serverError).toBe(
      "Confirm it's you with the code from your authenticator app to continue.",
    )

    use({ admin_find_customers: { error: { message: 'canceling statement due to timeout' } } })
    const lost = await findCustomers({ query: EMAIL })
    expect(lost.serverError).toBe(SERVER_CRASH_WORDS)
    expect(adminOutcome(lost)).toMatchObject({ ok: false, code: UNKNOWN_OUTCOME })
  })
})

describe('findCustomers', () => {
  it('sends the query to SQL in the request body, and answers its masked rows', async () => {
    const session = use({
      admin_find_customers: {
        data: {
          ok: true,
          auditId: 12,
          code: null,
          rows: [
            {
              userId: ids.user,
              maskedEmail: 's•••@example.ng',
              joinedAt: '2026-09-01T10:00:00Z',
              domainsHeld: 2,
              ordersPaid: 1,
            },
          ],
        },
      },
    })
    const answer = await findCustomers({ query: `  ${EMAIL} ` })
    expect(calls(session)).toEqual([['admin_find_customers', { p_query: EMAIL }]])
    expect(answer.data).toEqual({
      ok: true,
      auditId: 12,
      data: [
        {
          userId: ids.user,
          maskedEmail: 's•••@example.ng',
          joinedAt: '2026-09-01T10:00:00Z',
          domainsHeld: 2,
          ordersPaid: 1,
        },
      ],
    })
    expect(logged()).not.toContain(EMAIL)
  })

  it('answers no rows when nothing matches', async () => {
    use({ admin_find_customers: { data: { ok: true, auditId: 13, rows: [] } } })
    expect((await findCustomers({ query: 'ND-001035' })).data).toEqual({
      ok: true,
      auditId: 13,
      data: [],
    })
  })
})

describe('revealCustomer: refusals first', () => {
  it('validates before anything: a bad id or key, or a long reason, reaches no session', async () => {
    const session = use()
    for (const input of [
      { userId: 'someone@example.ng', requestKey: ids.key },
      { userId: ids.user, requestKey: 'again' },
      { userId: ids.user, requestKey: ids.key, reason: 'x'.repeat(501) },
    ]) {
      const answer = await revealCustomer(input)
      expect(answer.validationErrors).toBeDefined()
    }
    expect(session.rpc).not.toHaveBeenCalled()
  })

  it('refuses a viewer before SQL is asked to show anything', async () => {
    const session = use({}, 'viewer')
    const answer = await revealCustomer({ userId: ids.user, requestKey: ids.key })
    expect(answer.serverError).toBe("Your admin role can't do this. Ask the owner.")
    expect(calls(session)).toEqual([])
  })

  it('passes on the gate’s refusal of a test admin, with no details', async () => {
    use({ admin_reveal_customer: { data: { ok: false, auditId: 7, code: 'TEST_ADMIN' } } })
    const answer = await revealCustomer({ userId: ids.user, requestKey: ids.key })
    expect(answer.data).toEqual({
      ok: false,
      code: 'TEST_ADMIN',
      message: "Test administrators can't do this on live records.",
      auditId: 7,
    })
  })

  it('answers a replayed key without details, so the page asks again (D4)', async () => {
    use({ admin_reveal_customer: { data: { ok: true, auditId: 8, replayed: true } } })
    const answer = await revealCustomer({ userId: ids.user, requestKey: ids.key })
    expect(answer.data).toEqual({ ok: true, auditId: 8, replayed: true })
  })
})

describe('revealCustomer', () => {
  it('shows this view’s contact, its reason optional, and logs none of it', async () => {
    const contact = {
      email: EMAIL,
      fullName: 'Ada Obi',
      phone: '+2348012345678',
      businessName: null,
    }
    const session = use({
      admin_reveal_customer: { data: { ok: true, auditId: 9, code: null, contact } },
    })
    const answer = await revealCustomer({ userId: ids.user, requestKey: ids.key })
    expect(calls(session)).toEqual([
      ['admin_reveal_customer', { p_user_id: ids.user, p_reason: '', p_request_key: ids.key }],
    ])
    expect(answer.data).toEqual({ ok: true, auditId: 9, data: contact })

    await revealCustomer({
      userId: ids.user,
      requestKey: ids.key,
      reason: '  Customer called about a refund  ',
    })
    expect(calls(session).at(-1)).toEqual([
      'admin_reveal_customer',
      {
        p_user_id: ids.user,
        p_reason: 'Customer called about a refund',
        p_request_key: ids.key,
      },
    ])
    expect(logged()).not.toContain(EMAIL)
    expect(logged()).not.toContain('Ada Obi')
  })
})
