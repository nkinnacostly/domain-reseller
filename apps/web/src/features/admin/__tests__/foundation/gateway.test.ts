import { HttpResponse, http } from 'msw'
import { cookies, headers } from 'next/headers'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkFlutterwaveRefund,
  checkRenewable,
  checkSupplierPrice,
  lookupDomain,
  lookupSsl,
  readLiveBalance,
  readRegistrantVerification,
  readRegistryPage,
  readTransferState,
  searchLiveLedger,
} from '@/features/admin/actions/supplier-live'
import { callAdminGateway } from '@/features/admin/queries/gateway'
import { adminWhoami } from '@/features/admin/queries/session'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'
import { server } from '../../../../../tests/mocks/server'
import { sessionClient, whoami } from './fixtures'

vi.hoisted(() => {
  vi.stubEnv('GATEWAY_URL', 'http://gateway.test')
  vi.stubEnv('GATEWAY_SHARED_SECRET', 'test-secret-value-16')
  vi.stubEnv('GATEWAY_ADMIN_SECRET', 'admin-secret-value-0123456789abcdef')
})
afterAll(() => vi.unstubAllEnvs())

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const BASE = 'http://gateway.test/v1'

type Seen = { url: URL; method: string; headers: Headers }

function capture(path: string, reply?: () => Response) {
  const seen: Seen[] = []
  server.use(
    http.all(`${BASE}/${path}`, async ({ request }) => {
      seen.push({ url: new URL(request.url), method: request.method, headers: request.headers })
      return reply?.() ?? HttpResponse.json({ ok: true, data: { read: true } })
    }),
  )
  return seen
}

function onSide(side: 'live' | 'test') {
  vi.mocked(cookies).mockResolvedValue({ get: () => ({ value: side }), set: vi.fn() } as never)
}

/** An admin whose note SQL accepts with this id (or refuses with this code). */
function admin({
  note = { ok: true, auditId: 41 } as Record<string, unknown>,
  role = 'operator',
  testOnly = false,
} = {}) {
  const session = sessionClient({
    rpc: {
      admin_whoami: { data: whoami({ role, testOnly, label: 'ops' }) },
      admin_note: { data: note },
    },
  })
  vi.mocked(createClient).mockResolvedValue(session.client as never)
  return session
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(headers).mockResolvedValue(new Headers() as never)
  onSide('test')
})

describe('callAdminGateway', () => {
  it('sends the admin secret, the note and the label, and logs the template, never the filled path (N13)', async () => {
    const seen = capture('admin/supplier/domains/secret-client.com/transfer')
    const debug = vi.spyOn(logger, 'debug')
    try {
      const session = sessionClient({ rpc: { admin_whoami: { data: whoami({ label: 'ops' }) } } })
      const principal = await adminWhoami(session.client as never, null)

      await callAdminGateway({
        admin: principal,
        auditId: 41,
        route: 'admin/supplier/domains/:name/transfer',
        params: { name: 'secret-client.com' },
        query: { side: 'test', empty: undefined },
      })

      expect(seen[0]?.headers.get('x-admin-secret')).toBe('admin-secret-value-0123456789abcdef')
      expect(seen[0]?.headers.get('x-admin-audit-id')).toBe('41')
      expect(seen[0]?.headers.get('x-admin-label')).toBe('ops')
      expect(seen[0]?.url.search).toBe('?side=test')
      expect(JSON.stringify(debug.mock.calls)).toContain('admin/supplier/domains/:name/transfer')
      expect(JSON.stringify(debug.mock.calls)).not.toContain('secret-client')
    } finally {
      debug.mockRestore()
    }
  })

  it('refuses a route the gateway does not serve', async () => {
    const session = sessionClient({ rpc: { admin_whoami: { data: whoami() } } })
    const principal = await adminWhoami(session.client as never, null)
    await expect(
      callAdminGateway({ admin: principal, auditId: 1, route: 'domains/register' as never }),
    ).rejects.toThrow('not an admin gateway route')
  })
})

describe('live supplier reads (D22)', () => {
  it('writes the note first, then calls the gateway with its id', async () => {
    const session = admin()
    const seen = capture('admin/supplier/domains/example.com')

    const result = await lookupDomain({ name: 'Example.COM' })

    expect(session.rpc).toHaveBeenCalledWith('admin_note', {
      p_action: 'supplier.domain_lookup',
      p_side: 'test',
      p_target_type: 'domain',
      p_target_id: 'example.com',
      p_detail: {},
    })
    expect(seen[0]?.headers.get('x-admin-audit-id')).toBe('41')
    expect(seen[0]?.url.searchParams.get('side')).toBe('test')
    expect(result.data).toEqual({ ok: true, auditId: 41, data: { read: true } })
  })

  it('stops when SQL refuses the note: the gateway is never called', async () => {
    admin({ note: { ok: false, code: 'TEST_ADMIN', auditId: 42 } })
    const seen = capture('admin/supplier/balance')

    const result = await readLiveBalance({})

    expect(seen).toHaveLength(0)
    expect(result.data).toEqual({
      ok: false,
      code: 'TEST_ADMIN',
      message: "Test administrators can't do this on live records.",
      auditId: 42,
    })
  })

  it("words the gateway's refusal of the note by its reason", async () => {
    admin()
    capture('admin/supplier/balance', () =>
      HttpResponse.json(
        { ok: false, code: 'ADMIN_NOTE_REFUSED', reason: 'EXPIRED', message: 'refused' },
        { status: 403 },
      ),
    )
    const result = await readLiveBalance({})
    expect(result.data).toMatchObject({ ok: false, code: 'EXPIRED', auditId: 41 })
  })

  it("words the gateway's own refusals", async () => {
    admin()
    capture('admin/supplier/balance', () =>
      HttpResponse.json({ ok: false, code: 'OTHER_SIDE', message: 'other side' }, { status: 409 }),
    )
    const result = await readLiveBalance({})
    expect(result.data).toMatchObject({
      ok: false,
      code: 'OTHER_SIDE',
      message: 'The gateway reads the other side. Switch sides to read this.',
    })
  })

  it('validates before writing any note', async () => {
    const session = admin()
    const result = await lookupDomain({ name: 'not a domain' })
    expect(result.validationErrors).toBeDefined()
    expect(session.rpc).not.toHaveBeenCalled()
  })

  it('refuses in words when SQL raises on the note', async () => {
    const session = sessionClient({
      rpc: {
        admin_whoami: { data: whoami({ role: 'operator' }) },
        admin_note: { error: { message: 'admin:unknown_action' } },
      },
    })
    vi.mocked(createClient).mockResolvedValue(session.client as never)
    const result = await readLiveBalance({})
    expect(result.serverError).toBe(
      "The dashboard asked for something the database doesn't know. Nothing changed.",
    )
  })

  it('notes a price check as global and names the extension', async () => {
    const session = admin({ role: 'operator' })
    const seen = capture('admin/supplier/prices/com.ng')
    await checkSupplierPrice({ tld: '.COM.NG', op: 'renew', years: 2 })
    expect(session.rpc).toHaveBeenCalledWith(
      'admin_note',
      expect.objectContaining({
        p_action: 'supplier.price_check',
        p_side: 'global',
        p_target_id: 'com.ng',
      }),
    )
    expect(seen[0]?.url.searchParams.get('op')).toBe('renew')
    expect(seen[0]?.url.searchParams.get('years')).toBe('2')
  })

  it('names one refund for a Flutterwave check, and only one', async () => {
    const session = admin()
    const seen = capture('admin/flutterwave/refunds/FLW-123')
    const refundId = '0f0e0d0c-0b0a-4908-8706-050403020100'
    await checkFlutterwaveRefund({ flwRefundId: 'FLW-123', refundId })
    expect(session.rpc).toHaveBeenCalledWith(
      'admin_note',
      expect.objectContaining({
        p_action: 'refund.flw_check',
        p_target_type: 'flw_refund',
        p_target_id: 'FLW-123',
        p_detail: { refund_id: refundId },
      }),
    )
    expect(seen[0]?.url.searchParams.get('refund')).toBe(refundId)

    const both = await checkFlutterwaveRefund({ flwRefundId: 'FLW-123', refundId, incidentId: 4 })
    expect(both.validationErrors).toBeDefined()
  })

  it('asks about an incident by its number', async () => {
    admin()
    const seen = capture('admin/flutterwave/refunds/FLW-9')
    await checkFlutterwaveRefund({ flwRefundId: 'FLW-9', incidentId: 12 })
    expect(seen[0]?.url.searchParams.get('incident')).toBe('12')
  })

  it.each([
    [
      'readRegistrantVerification',
      () => readRegistrantVerification({ name: 'example.com' }),
      'admin/supplier/domains/example.com/verification',
    ],
    [
      'readTransferState',
      () => readTransferState({ name: 'example.com' }),
      'admin/supplier/domains/example.com/transfer',
    ],
    [
      'checkRenewable',
      () => checkRenewable({ name: 'example.com', years: 1 }),
      'admin/supplier/domains/example.com/renewable',
    ],
    ['lookupSsl', () => lookupSsl({ name: '*.example.com' }), 'admin/supplier/ssl/:name'],
    ['readRegistryPage', () => readRegistryPage({ skip: 25, take: 25 }), 'admin/supplier/domains'],
    [
      'searchLiveLedger',
      () => searchLiveLedger({ q: 'example.com', trace: 'B0E1C2D3-0000-0000-0000-00000000000A' }),
      'admin/supplier/transactions',
    ],
  ] as const)('%s reads its route once', async (_, run, path) => {
    admin()
    const seen = capture(path)
    const result = await run()
    expect(result.data).toMatchObject({ ok: true, auditId: 41 })
    expect(seen).toHaveLength(1)
  })

  it('sends a ledger trace lower-cased, as the gateway stores it', async () => {
    admin()
    const seen = capture('admin/supplier/transactions')
    await searchLiveLedger({ trace: 'B0E1C2D3-0000-0000-0000-00000000000A' })
    expect(seen[0]?.url.searchParams.get('trace')).toBe('b0e1c2d3-0000-0000-0000-00000000000a')
  })
})
