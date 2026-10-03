import { headers } from 'next/headers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { queueDeepSync, revealRegistrant } from '@/features/admin/actions/domains'
import { REVEAL } from '@/features/admin/lib/domains-copy'
import { ADMIN_ERROR_WORDS, SERVER_CRASH_WORDS } from '@/features/admin/lib/errors'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'
import { sessionClient, whoami } from '../foundation/fixtures'

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const DOMAIN = '5a5b5c5d-6e6f-4a7b-8c8d-9e9fa0a1b2b3'
const KEY = '0f0e0d0c-0b0a-4908-8706-050403020100'
const input = { domainId: DOMAIN, requestKey: KEY }

function use(session: ReturnType<typeof sessionClient>) {
  vi.mocked(createClient).mockResolvedValue(session.client as never)
  return session
}

const registrant = {
  firstName: 'Ada',
  lastName: 'Obi',
  company: '',
  email: 'ada@example.net',
  phoneCountryCode: '234',
  phone: '8030000000',
  addressLine1: '1 Marina',
  city: 'Lagos',
  state: 'Lagos',
  zipCode: '100001',
  country: 'NG',
  // Anything a stored contact carries beyond the Contact fields is dropped.
  internalNote: 'never shown',
  authCode: 'never shown either',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(headers).mockResolvedValue(new Headers() as never)
})

describe('queueDeepSync (§5.2 B9): standard tier, one wrapper', () => {
  it('calls admin_queue_deep_sync with the id, the reason or none, and the request key', async () => {
    const session = use(
      sessionClient({
        rpc: {
          admin_whoami: { data: whoami({ role: 'operator', label: 'ops' }) },
          admin_queue_deep_sync: { data: { ok: true, auditId: 7, after: { queued: true } } },
        },
      }),
    )
    const result = await queueDeepSync({ ...input, domainId: DOMAIN.toUpperCase() })
    expect(result.data).toEqual({ ok: true, auditId: 7, after: { queued: true } })
    // The standard tier: the 12-hour admin session, no code asked.
    expect(session.rpc).toHaveBeenCalledWith('admin_whoami', {})
    expect(session.challengeAndVerify).not.toHaveBeenCalled()
    expect(session.rpc).toHaveBeenLastCalledWith('admin_queue_deep_sync', {
      p_domain_id: DOMAIN,
      p_reason: null,
      p_request_key: KEY,
    })

    await queueDeepSync({ ...input, reason: '  the reconcile flagged it  ' })
    expect(session.rpc).toHaveBeenLastCalledWith('admin_queue_deep_sync', {
      p_domain_id: DOMAIN,
      p_reason: 'the reconcile flagged it',
      p_request_key: KEY,
    })
  })

  it('validates first: a bad id, key or long reason reaches nothing', async () => {
    const session = use(sessionClient({ rpc: { admin_whoami: { data: whoami() } } }))
    for (const bad of [
      { ...input, domainId: 'getpaid.com' },
      { ...input, requestKey: 'again' },
      { ...input, reason: 'x'.repeat(501) },
    ]) {
      expect((await queueDeepSync(bad)).validationErrors).toBeDefined()
    }
    expect(session.rpc).not.toHaveBeenCalled()
  })

  it("answers the wrapper's refusal in words: NO_GATEWAY, NOT_SYNCABLE", async () => {
    use(
      sessionClient({
        rpc: {
          admin_whoami: { data: whoami() },
          admin_queue_deep_sync: [
            { data: { ok: false, code: 'NO_GATEWAY', auditId: 8 } },
            { data: { ok: false, code: 'NOT_SYNCABLE', auditId: 9 } },
          ],
        },
      }),
    )
    expect((await queueDeepSync(input)).data).toEqual({
      ok: false,
      code: 'NO_GATEWAY',
      message: ADMIN_ERROR_WORDS.NO_GATEWAY,
      auditId: 8,
    })
    expect((await queueDeepSync(input)).data).toMatchObject({
      code: 'NOT_SYNCABLE',
      message: ADMIN_ERROR_WORDS.NOT_SYNCABLE,
    })
  })

  it('refuses a viewer in words before any wrapper is called', async () => {
    const session = use(
      sessionClient({ rpc: { admin_whoami: { data: whoami({ role: 'viewer' }) } } }),
    )
    expect(await queueDeepSync(input)).toEqual({
      serverError: "Your admin role can't do this. Ask the owner.",
    })
    expect(session.rpc).not.toHaveBeenCalledWith('admin_queue_deep_sync', expect.anything())
  })

  it('treats an error that is not an admin code as an unknown outcome, never its text (N10)', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined as never)
    use(
      sessionClient({
        rpc: {
          admin_whoami: { data: whoami() },
          admin_queue_deep_sync: { error: { message: 'fetch failed' } },
        },
      }),
    )
    expect(await queueDeepSync(input)).toEqual({ serverError: SERVER_CRASH_WORDS })
  })
})

describe('revealRegistrant (§5.2 B9): audited, rate-limited, details to the browser only', () => {
  it('returns the registrant and contacts, field by allowlisted field', async () => {
    const session = use(
      sessionClient({
        rpc: {
          admin_whoami: { data: whoami({ role: 'operator', testOnly: true }) },
          admin_reveal_registrant: {
            data: {
              ok: true,
              auditId: 11,
              code: null,
              message: null,
              after: null,
              registrant,
              contacts: {
                technical: { ...registrant, firstName: 'Tech', email: 'tech@example.net' },
                billing: 'not a contact',
                reseller: { firstName: 'Nobody' },
              },
            },
          },
        },
      }),
    )
    const info = vi.spyOn(logger, 'info')
    const result = await revealRegistrant({ ...input, reason: 'customer asked for a copy' })

    expect(session.rpc).toHaveBeenLastCalledWith('admin_reveal_registrant', {
      p_domain_id: DOMAIN,
      p_reason: 'customer asked for a copy',
      p_request_key: KEY,
    })
    const shown = {
      firstName: 'Ada',
      lastName: 'Obi',
      email: 'ada@example.net',
      phoneCountryCode: '234',
      phone: '8030000000',
      addressLine1: '1 Marina',
      city: 'Lagos',
      state: 'Lagos',
      zipCode: '100001',
      country: 'NG',
    }
    expect(result.data).toEqual({
      ok: true,
      auditId: 11,
      data: {
        registrant: shown,
        contacts: [
          {
            role: 'technical',
            contact: { ...shown, firstName: 'Tech', email: 'tech@example.net' },
          },
        ],
      },
    })
    expect(JSON.stringify(result)).not.toContain('never shown')
    // N13: nothing of the contact reaches a log line.
    expect(JSON.stringify(info.mock.calls)).not.toContain('ada@example.net')
  })

  it('shows no details for a replayed key, and asks again with a new one', async () => {
    use(
      sessionClient({
        rpc: {
          admin_whoami: { data: whoami({ role: 'operator' }) },
          admin_reveal_registrant: { data: { ok: true, auditId: 12, replayed: true } },
        },
      }),
    )
    expect((await revealRegistrant(input)).data).toEqual({
      ok: false,
      code: 'REPLAYED',
      message: REVEAL.replayed,
      auditId: 12,
    })
  })

  it('passes a refusal through in words: TEST_ADMIN, RATE_LIMITED', async () => {
    use(
      sessionClient({
        rpc: {
          admin_whoami: { data: whoami({ role: 'operator', testOnly: true }) },
          admin_reveal_registrant: [
            { data: { ok: false, code: 'TEST_ADMIN', auditId: 13 } },
            { data: { ok: false, code: 'RATE_LIMITED', auditId: 14 } },
          ],
        },
      }),
    )
    expect((await revealRegistrant(input)).data).toMatchObject({
      ok: false,
      code: 'TEST_ADMIN',
      message: "Test administrators can't do this on live records.",
    })
    expect((await revealRegistrant(input)).data).toMatchObject({
      code: 'RATE_LIMITED',
      message: ADMIN_ERROR_WORDS.RATE_LIMITED,
    })
  })

  it('reads a missing registrant as none, and a raised gate code as a refusal', async () => {
    use(
      sessionClient({
        rpc: {
          admin_whoami: { data: whoami({ role: 'operator' }) },
          admin_reveal_registrant: [
            { data: { ok: true, auditId: 15, registrant: null, contacts: null } },
            { error: { message: 'admin:needs_code' } },
          ],
        },
      }),
    )
    expect((await revealRegistrant(input)).data).toEqual({
      ok: true,
      auditId: 15,
      data: { registrant: null, contacts: [] },
    })
    expect(await revealRegistrant(input)).toEqual({
      serverError: ADMIN_ERROR_WORDS.needs_code,
    })
  })
})
