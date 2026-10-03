import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../app'
import { TokenBucket } from '../lib/rate-limit'
import { QueueTimeout } from '../lib/semaphore'
import type { CatalogueRun } from './routes'
import { createAdminRouter, ourCostCents } from './routes'
import { adminHeaders, fakeDeps, fakeSupplier, type SupplierCall } from './test-kit'

// biome-ignore lint/suspicious/noExplicitAny: answers are JSON, read field by field by the tests
type Json = any
const read = async (response: Response): Promise<Json> => response.json()

/**
 * ADMIN-SPEC §4.3, §4.6: every `/v1/admin/*` route — lanes, caches,
 * throttles, sides, the supplier's shapes in cents, and what is recorded.
 * Fixtures are the shapes read from the supplier on 2 Oct 2026 (production
 * reads, and the OTE sandbox for transfer and renew checks).
 */

const SENTINEL = 'SENTINEL-PII-7f3a'

const LEDGER_PAGE = {
  status: 200,
  body: {
    totalCount: 3,
    items: [
      {
        traceId: 'A476642F-9956-7CE2-9B08-3A23E027661E',
        creationTime: '2026-09-30T14:15:46.53',
        type: 1,
        status: 1,
        chargeType: 1,
        productType: 1,
        period: 1,
        amount: 0,
        oldBalance: 15.0,
        balance: 3.69,
        description: 'mydomainshub.com',
        resellerName: SENTINEL,
      },
      {
        traceId: '38e14b09-3eb8-b811-78ce-3a2400360393',
        creationTime: '2026-10-01T19:39:33.5269574',
        type: 5,
        status: 1,
        chargeType: 0,
        productType: 3,
        period: 1,
        amount: 0,
        oldBalance: 7.38,
        balance: 43.38,
        description: 'Ziraat Payment (Order: 20260929193857113-32A4)',
      },
      // Outside the asked range once read back in UTC: dropped.
      {
        traceId: '811cb0db-78ba-112a-9073-3a23e015b6f1',
        creationTime: '2026-09-25T13:56:25.8447385',
        type: 5,
        status: 1,
        chargeType: 0,
        productType: 3,
        period: 1,
        amount: 0,
        oldBalance: 0,
        balance: 15,
        description: 'Ziraat Payment',
      },
    ],
  },
}

function setup(
  over: Parameters<typeof fakeDeps>[0] = {},
  answers: Parameters<typeof fakeSupplier>[0] = {},
) {
  const { supplier, calls } = fakeSupplier({
    '/deposit/accounts/me': {
      status: 200,
      body: { usdBalance: 43.38, resellerGroupName: 'Reseller', resellerName: SENTINEL },
    },
    '/deposit/transactions': LEDGER_PAGE,
    '/domains': {
      status: 200,
      body: {
        totalCount: 1,
        items: [
          {
            domainName: 'mydomainshubtest1.com',
            status: 0,
            expirationDate: '2027-09-23T13:44:14.8005439',
            lockStatus: true,
            privacyProtectionStatus: true,
            renewalMode: 'AutoRenew',
            contacts: { Registrant: 'D-2HANDLE', Admin: SENTINEL },
            nameservers: [{ name: 'ns1.domainnameapi.com' }, { name: 'ns2.domainnameapi.com' }],
          },
        ],
      },
    },
    '/contacts/verification/check': {
      status: 200,
      body: {
        results: [
          {
            ownerName: SENTINEL,
            fieldValue: SENTINEL,
            fieldType: 'Email',
            operationStatus: 'Completed',
            userVerificationDate: '2026-09-20T08:48:08.52857+03:00',
            isUserVerified: true,
          },
        ],
      },
    },
    // OTE, 2 Oct 2026: a domain not in transfer.
    '/domains/transfers/query': {
      status: 400,
      body: {
        error: {
          code: 'Dna.DomainService:Domain:10025',
          message: 'Domain transferability check is not supported for this extension.',
          details: `${SENTINEL} is not in transfer status`,
        },
      },
    },
    // OTE, 2 Oct 2026: renewable for a year.
    '/domains/renew/check': {
      status: 200,
      body: { renewabilityStatus: true, renewalLock: false, errorMessageKey: null },
    },
    // Production, 2 Oct 2026: .com registration, OrderType 1.
    '/products/info': {
      status: 200,
      body: {
        productName: 'com',
        productCode: 'Domain.com',
        productType: 1,
        sellingPrice: 11.31,
        sellingCurrency: 'USD',
      },
    },
    ...answers,
  })
  const kit = fakeDeps({
    targetSupplier: () => supplier,
    catalogueSupplier: () => supplier,
    ...over,
  })
  const app = createApp({ admin: createAdminRouter(kit.deps) as never })
  const request = (path: string, init: RequestInit = {}) =>
    app.request(`/v1/admin${path}`, {
      ...init,
      headers: { ...adminHeaders(), ...(init.headers as object) },
    })
  return { app, request, calls, ...kit }
}

describe('the balance', () => {
  it('reads the target side with its key, in cents, tagged with the side — and caches it', async () => {
    const { request, calls, results } = setup()
    const response = await request('/supplier/balance?side=test')
    expect(await read(response)).toEqual({
      ok: true,
      data: {
        side: 'test',
        balanceCents: 4338,
        priceGroup: 'Reseller',
        readAt: '2026-10-02T12:00:00.000Z',
      },
    })
    await request('/supplier/balance?side=test')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.lane).toEqual({ priority: 'normal', waitMs: 10_000 })
    expect(results.at(-1)).toEqual([41, 'ok', null, { cents: 4338, cached: true }])
  })

  it('refuses the other side, and a gateway with writes off', async () => {
    const other = setup()
    const response = await other.request('/supplier/balance?side=live')
    expect(response.status).toBe(409)
    expect(await read(response)).toMatchObject({ code: 'OTHER_SIDE' })
    expect(other.claims).toHaveLength(0)
    const off = setup({ target: 'off' })
    const offResponse = await off.request('/supplier/balance?side=test')
    expect(offResponse.status).toBe(503)
    expect(await read(offResponse)).toMatchObject({ code: 'WRITES_OFF' })
    const missing = await other.request('/supplier/balance')
    expect(missing.status).toBe(400)
  })

  it('answers 503 when no supplier slot frees up in time', async () => {
    const { request, deps, results } = setup()
    deps.targetSupplier = () => ({
      environment: 'ote',
      get: async () => {
        throw new QueueTimeout()
      },
      postRead: async () => {
        throw new QueueTimeout()
      },
    })
    const response = await request('/supplier/balance?side=test')
    expect(response.status).toBe(503)
    expect(await read(response)).toMatchObject({ code: 'SUPPLIER_BUSY', retryable: true })
    expect(results.at(-1)).toEqual([41, 'refused', 'SUPPLIER_BUSY', {}])
  })

  it('maps a supplier refusal to our words, never theirs', async () => {
    const { request } = setup(
      {},
      {
        '/deposit/accounts/me': {
          status: 403,
          body: { error: { code: 'API_301', message: SENTINEL } },
        },
      },
    )
    const response = await request('/supplier/balance?side=test')
    expect(response.status).toBe(502)
    const body = await read(response)
    expect(body.code).toBe('SUPPLIER_IP_BLOCKED')
    expect(JSON.stringify(body)).not.toContain(SENTINEL)
    const busy = setup({}, { '/deposit/accounts/me': { status: 429, body: {} } })
    expect((await busy.request('/supplier/balance?side=test')).status).toBe(503)
    const odd = setup({}, { '/deposit/accounts/me': { status: 200, body: { nothing: true } } })
    expect(await read(await odd.request('/supplier/balance?side=test'))).toMatchObject({
      code: 'UNREADABLE',
    })
    const creds = setup({}, { '/deposit/accounts/me': { status: 401, body: {} } })
    expect(await read(await creds.request('/supplier/balance?side=test'))).toMatchObject({
      code: 'SUPPLIER_AUTH',
    })
    const other = setup({}, { '/deposit/accounts/me': { status: 500, body: {} } })
    expect(await read(await other.request('/supplier/balance?side=test'))).toMatchObject({
      code: 'SUPPLIER_UNAVAILABLE',
    })
  })

  it('refuses when the shared allowance is spent, before claiming anything', async () => {
    const { request, claims } = setup({ bucket: new TokenBucket(1, 0) })
    await request('/supplier/balance?side=test')
    const response = await request('/supplier/balance?side=test')
    expect(response.status).toBe(429)
    expect(claims).toHaveLength(1)
  })

  it('records a programming error as a failure, not a supplier call', async () => {
    const { request, deps } = setup()
    deps.targetSupplier = () => {
      throw new Error('boom')
    }
    const response = await request('/supplier/balance?side=test')
    expect(response.status).toBe(502)
  })
})

describe('the live ledger', () => {
  it('always sends both dates, widened a day, filters back in UTC, and spends from the balances', async () => {
    const { request, calls } = setup()
    const response = await request(
      '/supplier/transactions?side=test&from=2026-09-30&to=2026-10-02&take=50',
    )
    const body = await read(response)
    expect(calls[0]?.params).toMatchObject({
      StartDate: '2026-09-29',
      EndDate: '2026-10-04',
      Sorting: 'creationTime desc',
      SkipCount: 0,
      MaxResultCount: 50,
    })
    expect(calls[0]?.lane).toEqual({ priority: 'low', waitMs: 15_000 })
    expect(body.data.side).toBe('test')
    expect(
      body.data.items.map((item: { traceId: string; deltaCents: number; kind: string }) => [
        item.traceId,
        item.deltaCents,
        item.kind,
      ]),
    ).toEqual([
      ['a476642f-9956-7ce2-9b08-3a23e027661e', -1131, 'domain_charge'],
      ['38e14b09-3eb8-b811-78ce-3a2400360393', 3600, 'topup'],
    ])
    expect(body.data.items[0].occurredAt).toBe('2026-09-30T11:15:46.530Z')
    expect(JSON.stringify(body)).not.toContain(SENTINEL)
  })

  it('passes the filters through, by their allowlisted names', async () => {
    const { request, calls } = setup()
    await request(
      '/supplier/transactions?side=test&type=1&productType=1&q=MyDomainsHub.com&trace=A476642F-9956-7CE2-9B08-3A23E027661E&skip=10',
    )
    expect(calls[0]?.params).toMatchObject({
      TransactionTypes: 1,
      ProductTypes: 1,
      FilterText: 'mydomainshub.com',
      TraceId: 'a476642f-9956-7ce2-9b08-3a23e027661e',
      SkipCount: 10,
    })
  })

  it('refuses bad input before claiming the note', async () => {
    const { request, claims } = setup()
    for (const query of [
      'take=101',
      'from=2025-01-01&to=2026-10-02',
      'type=99',
      'q=not a host',
      'trace=xyz',
      'skip=-1',
    ]) {
      expect((await request(`/supplier/transactions?side=test&${query}`)).status).toBe(400)
    }
    expect(claims).toHaveLength(0)
  })

  it('serves the same query from the cache for a minute', async () => {
    const { request, calls } = setup()
    await request('/supplier/transactions?side=test')
    await request('/supplier/transactions?side=test')
    expect(calls).toHaveLength(1)
  })

  it('fails a page the supplier refused', async () => {
    const { request } = setup({}, { '/deposit/transactions': { status: 500, body: {} } })
    expect((await request('/supplier/transactions?side=test')).status).toBe(502)
  })
})

describe('the registry', () => {
  it('pages our listing without contacts, in the low lane, cached', async () => {
    const { request, calls } = setup()
    const response = await request(
      '/supplier/domains?side=test&skip=0&take=10&name=MyDomainsHubTest1.com',
    )
    const body = await read(response)
    expect(body.data.items).toEqual([
      expect.objectContaining({
        name: 'mydomainshubtest1.com',
        status: 'Active',
        renewalModeLabel: 'AutoRenew',
      }),
    ])
    expect(JSON.stringify(body)).not.toContain(SENTINEL)
    expect(calls[0]).toMatchObject({
      params: { SkipCount: 0, MaxResultCount: 10, DomainName: 'mydomainshubtest1.com' },
    })
    await request('/supplier/domains?side=test&skip=0&take=10&name=mydomainshubtest1.com')
    expect(calls).toHaveLength(1)
    expect((await request('/supplier/domains?side=test&take=500')).status).toBe(400)
  })

  it('looks one domain up, recorded as AdminGetDetails by the registrar, at most once in 30 seconds', async () => {
    const lookup = vi.fn(async () => ({
      kind: 'found' as const,
      domain: {
        registeredAt: '2026-09-23T10:44:14.000Z',
        expiresAt: '2027-09-23T10:44:14.000Z',
        nameservers: ['ns1.domainnameapi.com'],
        transferLock: true,
        privacy: true,
        status: 'Active',
      },
    }))
    const { request, claims } = setup({ lookup: () => lookup })
    const response = await request('/supplier/domains/MyDomainsHubTest1.com?side=test')
    expect(await read(response)).toMatchObject({
      ok: true,
      data: { name: 'mydomainshubtest1.com', outcome: 'ok', status: 'Active', transferLock: true },
    })
    expect(claims.at(-1)).toEqual([
      41,
      'supplier.domain_lookup',
      'owner',
      'test',
      'mydomainshubtest1.com',
    ])
    const again = await request('/supplier/domains/mydomainshubtest1.com?side=test')
    expect(again.status).toBe(429)
    expect(await read(again)).toMatchObject({ code: 'TOO_SOON' })
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('says not found, and fails an answer it cannot settle', async () => {
    const notFound = setup({ lookup: () => async () => ({ kind: 'not_found' as const }) })
    expect(
      await read(await notFound.request('/supplier/domains/gone.com?side=test')),
    ).toMatchObject({
      data: { outcome: 'not_found', nameservers: [] },
    })
    const unknown = setup({
      lookup: () => async () => ({ kind: 'unknown' as const, code: 'TIMEOUT', message: SENTINEL }),
    })
    const response = await unknown.request('/supplier/domains/slow.com?side=test')
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain(SENTINEL)
    const blocked = setup({
      lookup: () => async () => ({
        kind: 'blocked' as const,
        code: 'SUPPLIER_IP_BLOCKED' as const,
        message: 'x',
      }),
    })
    expect(await read(await blocked.request('/supplier/domains/x.com?side=test'))).toMatchObject({
      code: 'SUPPLIER_IP_BLOCKED',
    })
    const off = setup()
    expect((await off.request('/supplier/domains/x.com?side=test')).status).toBe(503)
    expect((await off.request('/supplier/domains/not_a_name?side=test')).status).toBe(400)
  })

  it('reads the registrant’s verification by its handle, keeping neither the handle nor the address', async () => {
    const { request, calls, log } = setup()
    const response = await request('/supplier/domains/mydomainshubtest1.com/verification?side=test')
    const body = await read(response)
    expect(body.data).toMatchObject({
      name: 'mydomainshubtest1.com',
      isVerified: true,
      fieldType: 'Email',
    })
    expect(JSON.stringify(body)).not.toContain('D-2HANDLE')
    expect(JSON.stringify(body)).not.toContain(SENTINEL)
    expect(calls.map((call: SupplierCall) => call.path)).toEqual([
      '/domains',
      '/contacts/verification/check',
    ])
    expect(calls[1]?.params).toEqual({ HandleCode: 'D-2HANDLE' })
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('D-2HANDLE')
    await request('/supplier/domains/mydomainshubtest1.com/verification?side=test')
    expect(calls).toHaveLength(2)
  })

  it('finds this domain among near matches, case-blind, and reads only its handle', async () => {
    const { request, calls } = setup(
      {},
      {
        '/domains': {
          status: 200,
          body: {
            totalCount: 3,
            items: [
              { domainName: 'notmydomainshubtest1.com', contacts: { Registrant: 'D-OTHER' } },
              { domainName: 'MyDomainsHubTest1.com', contacts: { Registrant: 'D-OURS' } },
              { domainName: 'mydomainshubtest1.com.ng', contacts: { Registrant: 'D-LONGER' } },
            ],
          },
        },
      },
    )
    const body = await read(
      await request('/supplier/domains/mydomainshubtest1.com/verification?side=test'),
    )
    expect(body.data).toMatchObject({ name: 'mydomainshubtest1.com', isVerified: true })
    expect(calls.map((call: SupplierCall) => call.path)).toEqual([
      '/domains',
      '/contacts/verification/check',
    ])
    // Enough of the listing to find it when near matches come first.
    expect(calls[0]?.params).toMatchObject({ DomainName: 'mydomainshubtest1.com' })
    expect(Number(calls[0]?.params?.MaxResultCount)).toBeGreaterThan(1)
    expect(calls[1]?.params).toEqual({ HandleCode: 'D-OURS' })
  })

  it('takes the handle only from the listing item that is this domain, never a near match', async () => {
    const { request, calls } = setup(
      {},
      {
        '/domains': {
          status: 200,
          body: {
            totalCount: 1,
            items: [
              { domainName: 'notmydomainshubtest1.com', contacts: { Registrant: 'D-OTHER' } },
            ],
          },
        },
      },
    )
    expect(
      await read(await request('/supplier/domains/mydomainshubtest1.com/verification?side=test')),
    ).toEqual({ ok: true, data: null })
    expect(calls.map((call: SupplierCall) => call.path)).toEqual(['/domains'])
  })

  it('has no verification for a name not in our account', async () => {
    const { request } = setup(
      {},
      { '/domains': { status: 200, body: { totalCount: 0, items: [] } } },
    )
    expect(await read(await request('/supplier/domains/other.com/verification?side=test'))).toEqual(
      {
        ok: true,
        data: null,
      },
    )
  })
})

describe('transfers and renewals', () => {
  it('reads a name not in transfer as unknown — never as refused — and records the state', async () => {
    const { request, recordedCalls } = setup()
    const response = await request('/supplier/domains/mydomainshubtest1.com/transfer?side=test')
    expect(await read(response)).toMatchObject({
      data: { state: 'unknown', supplierStatus: 'not_in_transfer' },
    })
    expect(recordedCalls).toEqual([
      expect.objectContaining({
        operation: 'AdminTransferQuery',
        outcome: 'not_found',
        message: 'unknown',
      }),
    ])
    expect(JSON.stringify(recordedCalls)).not.toContain(SENTINEL)
  })

  it('records a refused transfer as `rejected`, which is what lets a person fail the job', async () => {
    const { request, recordedCalls } = setup(
      {},
      {
        '/domains/transfers/query': {
          status: 200,
          body: {
            domainName: 'moving.com',
            status: 'clientRejected',
            requestedDate: '2026-09-28T10:00:00',
            finalDate: '2026-09-30T10:00:00',
          },
        },
      },
    )
    const body = await read(await request('/supplier/domains/moving.com/transfer?side=test'))
    expect(body.data).toMatchObject({ state: 'rejected', finalAt: '2026-09-30T07:00:00.000Z' })
    expect(recordedCalls).toEqual([
      expect.objectContaining({ outcome: 'ok', message: 'rejected', httpStatus: 200 }),
    ])
  })

  it('fails a transfer read the supplier could not answer', async () => {
    const { request, recordedCalls } = setup(
      {},
      { '/domains/transfers/query': { status: 503, body: {} } },
    )
    expect((await request('/supplier/domains/x.com/transfer?side=test')).status).toBe(502)
    expect(recordedCalls).toEqual([expect.objectContaining({ outcome: 'unknown', message: null })])
  })

  it('checks renewability for a period, recorded as AdminRenewCheck', async () => {
    const { request, calls, recordedCalls } = setup()
    const body = await read(
      await request('/supplier/domains/mydomainshubtest1.com/renewable?side=test&years=2'),
    )
    expect(body.data).toMatchObject({ renewable: true, renewalLock: false, reasonKey: null })
    expect(calls[0]).toMatchObject({
      method: 'POST',
      body: { domainName: 'mydomainshubtest1.com', period: 2 },
    })
    expect(calls[0]?.lane).toEqual({ priority: 'normal', waitMs: 12_000 })
    expect(recordedCalls).toEqual([
      expect.objectContaining({ operation: 'AdminRenewCheck', message: 'renewable' }),
    ])
    expect((await request('/supplier/domains/x.com/renewable?side=test&years=11')).status).toBe(400)
  })

  it('records a renew check the supplier refused', async () => {
    const { request, recordedCalls } = setup(
      {},
      {
        '/domains/renew/check': {
          status: 404,
          body: { error: { code: 'Dna.DomainService:Domain:10007' } },
        },
      },
    )
    expect((await request('/supplier/domains/gone.com/renewable?side=test')).status).toBe(502)
    expect(recordedCalls).toEqual([expect.objectContaining({ outcome: 'not_found' })])
  })
})

describe('prices and the catalogue', () => {
  it('compares the supplier’s price with what tlds says we pay, in cents', async () => {
    const { request, calls, claims } = setup()
    const body = await read(await request('/supplier/prices/COM?op=register&years=1'))
    expect(body.data).toMatchObject({
      tld: 'com',
      op: 'register',
      years: 1,
      supplierCents: 1131,
      ourCents: 1131,
      matches: true,
    })
    expect(calls[0]?.params).toEqual({ ProductName: 'com', OrderType: 1, Period: 1 })
    expect(claims.at(-1)).toEqual([41, 'supplier.price_check', 'owner', 'global', 'com'])
    await request('/supplier/prices/com?op=register&years=1')
    expect(calls).toHaveLength(1)
    expect((await request('/supplier/prices/com?op=delete')).status).toBe(400)
  })

  it('works the cost out by the checkout’s own rule', () => {
    const ai = {
      registerUsd: 99.9,
      renewUsd: 99.9,
      transferUsd: 99.9,
      restoreUsd: null,
      firstTermYears: 2,
    }
    expect(ourCostCents(ai, 'register', 2)).toBe(19_980)
    expect(ourCostCents(ai, 'register', 4)).toBe(39_960)
    expect(ourCostCents(ai, 'register', 1)).toBeNull()
    expect(ourCostCents(ai, 'renew', 2)).toBe(19_980)
    expect(ourCostCents(ai, 'transfer', 1)).toBe(9_990)
    expect(ourCostCents(ai, 'restore', 1)).toBeNull()
    expect(ourCostCents({ ...ai, transferUsd: null, restoreUsd: 40 }, 'transfer', 1)).toBeNull()
    expect(ourCostCents({ ...ai, restoreUsd: 40 }, 'restore', 1)).toBe(4_000)
  })

  it('says when the price cannot be read, or no key is configured', async () => {
    const odd = setup({}, { '/products/info': { status: 200, body: { sellingPrice: 'n/a' } } })
    expect(await read(await odd.request('/supplier/prices/com'))).toMatchObject({
      code: 'UNREADABLE',
    })
    const none = setup({ catalogueSupplier: () => null })
    expect((await none.request('/supplier/prices/com')).status).toBe(503)
    const refused = setup({}, { '/products/info': { status: 404, body: {} } })
    expect((await refused.request('/supplier/prices/xyz')).status).toBe(502)
    const unpriced = setup()
    unpriced.deps.store.tldCost = vi.fn(async () => null)
    expect(await read(await unpriced.request('/supplier/prices/xyz'))).toMatchObject({
      data: { ourCents: null, matches: false },
    })
  })

  const run = (outcome: CatalogueRun['outcome']): CatalogueRun => ({
    outcome,
    reason: outcome === 'refused' ? 'Read 3 of 700' : null,
    listed: 700,
    sellable: 690,
    changes: 4,
    report: Array.from({ length: 250 }, (_, index) => `line ${index}`),
  })

  it('previews the catalogue once in flight and for ten minutes, the report cut to 200 lines', async () => {
    const preview = vi.fn(async () => run('changes'))
    const { request } = setup({
      catalogue: () => ({ preview, apply: vi.fn(async () => run('written')) }),
    })
    const [a, b] = await Promise.all([
      request('/supplier/catalogue/preview'),
      request('/supplier/catalogue/preview'),
    ])
    expect((await read(a)).data).toMatchObject({ kind: 'tlds', outcome: 'ok', changes: 4 })
    expect((await read(b)).data.report).toHaveLength(200)
    await request('/supplier/catalogue/preview')
    expect(preview).toHaveBeenCalledTimes(1)
  })

  it('applies at most once in ten minutes, and says so', async () => {
    const apply = vi.fn(async () => run('written'))
    const { request, claims } = setup({
      catalogue: () => ({ preview: vi.fn(async () => run('changes')), apply }),
    })
    const first = await request('/supplier/catalogue/apply', { method: 'POST' })
    expect(await read(first)).toMatchObject({ ok: true, data: { outcome: 'applied', changes: 4 } })
    const second = await request('/supplier/catalogue/apply', { method: 'POST' })
    expect(second.status).toBe(429)
    expect(await read(second)).toMatchObject({ code: 'TOO_SOON' })
    expect(apply).toHaveBeenCalledTimes(1)
    expect(claims.map((claim) => claim[1])).toEqual([
      'supplier.catalogue_apply',
      'supplier.catalogue_apply',
    ])
  })

  it('reports a refused listing, and refuses where the catalogue is not read', async () => {
    const { request } = setup({
      sslCatalogue: () => ({
        preview: vi.fn(async () => run('refused')),
        apply: vi.fn(async () => run('refused')),
      }),
    })
    expect((await read(await request('/supplier/ssl-catalogue/preview'))).data).toMatchObject({
      kind: 'ssl',
      outcome: 'refused',
      reason: 'Read 3 of 700',
    })
    expect(
      (await read(await request('/supplier/ssl-catalogue/apply', { method: 'POST' }))).data,
    ).toMatchObject({
      outcome: 'refused',
    })
    const none = setup()
    expect((await none.request('/supplier/catalogue/preview')).status).toBe(503)
    expect(
      await read(await none.request('/supplier/catalogue/apply', { method: 'POST' })),
    ).toMatchObject({
      code: 'NOT_PRODUCTION',
    })
  })
})

describe('certificates', () => {
  const status = {
    kind: 'found' as const,
    data: {
      domainName: 'shop.example.com',
      status: 'Active',
      isConfigured: true,
      isIssued: true,
      certificateExpiresAt: '2027-04-20T00:00:00.000Z',
    },
  }
  const details = {
    kind: 'found' as const,
    data: {
      status: 'Active',
      packageCode: '351',
      isConfigured: true,
      isIssued: true,
      purchasedAt: null,
      subscriptionEndsAt: '2027-10-02T00:00:00.000Z',
      issuedAt: null,
      validUntil: '2027-04-20T00:00:00.000Z',
    },
  }

  it('reads status and details, but only status for a wildcard', async () => {
    const ssl = { status: vi.fn(async () => status), details: vi.fn(async () => details) }
    const { request } = setup({ ssl: () => ssl })
    const body = await read(await request('/supplier/ssl/shop.example.com?side=test'))
    expect(body.data).toMatchObject({
      outcome: 'ok',
      isIssued: true,
      subscriptionEndsAt: '2027-10-02T00:00:00.000Z',
    })
    const wildcard = await read(await request('/supplier/ssl/*.example.com?side=test'))
    expect(wildcard.data).toMatchObject({ name: '*.example.com', validUntil: null })
    expect(ssl.details).toHaveBeenCalledTimes(1)
    expect((await request('/supplier/domains/*.example.com?side=test')).status).toBe(400)
  })

  it('says when there is none, and fails when it cannot tell', async () => {
    const missing = setup({
      ssl: () => ({
        status: vi.fn(async () => ({ kind: 'not_found' as const })),
        details: vi.fn(),
      }),
    })
    expect(
      (await read(await missing.request('/supplier/ssl/none.com?side=test'))).data,
    ).toMatchObject({ outcome: 'not_found' })
    const unknown = setup({
      ssl: () => ({
        status: vi.fn(async () => ({ kind: 'unknown' as const, code: 'TIMEOUT', message: 'x' })),
        details: vi.fn(),
      }),
    })
    expect((await unknown.request('/supplier/ssl/slow.com?side=test')).status).toBe(502)
    const off = setup()
    expect((await off.request('/supplier/ssl/x.com?side=test')).status).toBe(503)
  })
})

describe('a Flutterwave refund check', () => {
  const refund = {
    kind: 'ok' as const,
    data: {
      id: '123',
      transactionId: '456',
      amountKobo: 1_967_250,
      status: 'completed-mpgs',
      disburseStatus: null,
      createdAt: null,
    },
  }

  it('reads the refund with this side’s key, records the facts, and judges it done', async () => {
    const getRefund = vi.fn(async () => refund)
    const { request, flwChecks, claims, noteDetail } = setup({ flutterwave: () => ({ getRefund }) })
    noteDetail.refund_id = '8dbd7ea2-c535-4a4a-a091-e202d9185a20'
    const body = await read(
      await request(
        '/flutterwave/refunds/123?side=test&refund=8dbd7ea2-c535-4a4a-a091-e202d9185a20',
      ),
    )
    expect(body.data).toMatchObject({
      checkId: 77,
      flwRefundId: '123',
      transactionId: '456',
      amountKobo: 1_967_250,
      state: 'done',
    })
    expect(flwChecks).toEqual([
      expect.objectContaining({
        auditId: 41,
        testMode: true,
        targetType: 'refund',
        targetId: '8dbd7ea2-c535-4a4a-a091-e202d9185a20',
        state: 'done',
      }),
    ])
    expect(claims.at(-1)).toEqual([41, 'refund.flw_check', 'owner', 'test', '123'])
  })

  it('judges a bare `completed` as pending, and checks an incident too', async () => {
    const getRefund = vi.fn(async () => ({
      kind: 'ok' as const,
      data: { ...refund.data, status: 'completed' },
    }))
    const { request, flwChecks, noteDetail } = setup({ flutterwave: () => ({ getRefund }) })
    noteDetail.incident_id = '42'
    const body = await read(await request('/flutterwave/refunds/123?side=test&incident=42'))
    expect(body.data.state).toBe('pending')
    expect(flwChecks).toEqual([expect.objectContaining({ targetType: 'incident', targetId: '42' })])
  })

  it('records only what the note names: another refund or incident in the query is refused', async () => {
    const getRefund = vi.fn(async () => refund)
    const { request, flwChecks, noteDetail, results } = setup({
      flutterwave: () => ({ getRefund }),
    })
    noteDetail.refund_id = '8dbd7ea2-c535-4a4a-a091-e202d9185a20'
    const other = await request(
      '/flutterwave/refunds/123?side=test&refund=11111111-2222-4333-8444-555555555555',
    )
    expect(other.status).toBe(403)
    expect(await read(other)).toMatchObject({ code: 'TARGET_MISMATCH' })
    expect(
      await read(await request('/flutterwave/refunds/123?side=test&incident=7')),
    ).toMatchObject({ code: 'TARGET_MISMATCH' })
    // A note naming both, or neither, names nothing.
    noteDetail.incident_id = '7'
    expect((await request('/flutterwave/refunds/123?side=test&incident=7')).status).toBe(403)
    delete noteDetail.refund_id
    delete noteDetail.incident_id
    expect(
      (
        await request(
          '/flutterwave/refunds/123?side=test&refund=8dbd7ea2-c535-4a4a-a091-e202d9185a20',
        )
      ).status,
    ).toBe(403)
    expect(getRefund).not.toHaveBeenCalled()
    expect(flwChecks).toEqual([])
    expect(results.at(-1)).toEqual([41, 'refused', 'TARGET_MISMATCH', {}])
  })

  it('refuses bad input, and says when Flutterwave has none or did not answer', async () => {
    const { request, noteDetail } = setup({
      flutterwave: () => ({
        getRefund: vi.fn(async () => ({ kind: 'rejected' as const, code: 'x', message: 'x' })),
      }),
    })
    noteDetail.incident_id = '2'
    expect((await request('/flutterwave/refunds/123?side=test')).status).toBe(400)
    expect((await request('/flutterwave/refunds/123?side=test&refund=1&incident=2')).status).toBe(
      400,
    )
    expect((await request('/flutterwave/refunds/bad%20id?side=test&incident=2')).status).toBe(400)
    expect((await request('/flutterwave/refunds/123?side=test&incident=2')).status).toBe(404)
    const silent = setup({
      flutterwave: () => ({
        getRefund: vi.fn(async () => ({ kind: 'unknown' as const, code: 'x', message: 'x' })),
      }),
    })
    silent.noteDetail.incident_id = '2'
    expect((await silent.request('/flutterwave/refunds/123?side=test&incident=2')).status).toBe(503)
    const none = setup()
    none.noteDetail.incident_id = '2'
    expect((await none.request('/flutterwave/refunds/123?side=test&incident=2')).status).toBe(503)
  })
})

describe('a preset draft check', () => {
  const draft = {
    id: '8dbd7ea2-c535-4a4a-a091-e202d9185a20',
    provider: 'Vercel',
    nameservers: ['ns1.vercel-dns.com'],
  }

  it('checks an open draft once a minute, on the global side', async () => {
    const { request, deps, claims } = setup()
    deps.store.draft = vi.fn(async () => draft)
    const first = await request(`/presets/drafts/${draft.id}/check`, { method: 'POST' })
    expect(await read(first)).toMatchObject({ ok: true, data: { ok: true } })
    expect(claims.at(-1)).toEqual([41, 'preset.draft_check', 'owner', 'global', draft.id])
    const second = await request(`/presets/drafts/${draft.id}/check`, { method: 'POST' })
    expect(second.status).toBe(429)
    expect(deps.checkDraft).toHaveBeenCalledTimes(1)
  })

  it('refuses a draft that is not open, and a bad id', async () => {
    const { request } = setup()
    expect((await request(`/presets/drafts/${draft.id}/check`, { method: 'POST' })).status).toBe(
      404,
    )
    expect((await request('/presets/drafts/nope/check', { method: 'POST' })).status).toBe(400)
  })
})

describe('admin logs', () => {
  it('carry the route template, the admin and the note — never a domain name or personal data', async () => {
    const lookup = vi.fn(async () => ({ kind: 'not_found' as const }))
    const { request, log } = setup({ lookup: () => lookup })
    await request('/supplier/domains/secret-client-name.com?side=test')
    await request('/supplier/domains/mydomainshubtest1.com/verification?side=test')
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        route: '/v1/admin/supplier/domains/:name',
        adminLabel: 'owner',
        auditId: 41,
        outcome: 200,
      }),
      'admin request',
    )
    const logged = JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls])
    expect(logged).not.toContain('secret-client-name')
    expect(logged).not.toContain('mydomainshubtest1')
    expect(logged).not.toContain(SENTINEL)
  })
})
