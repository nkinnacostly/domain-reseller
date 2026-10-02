import { HttpResponse, http } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { server } from '../../../../tests/mocks/server'

vi.mock('next/cache', () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))

process.env.GATEWAY_URL ??= 'http://gateway.test'
process.env.GATEWAY_SHARED_SECRET ??= 'test-secret-value-at-least-16'

const { getSslCatalogue, readSslCatalogue } = await import('../queries/catalogue')
const { sslNameInUse } = await import('../queries/names')
const { getMyCertificate, getOrderCertificates, listMyCertificates } = await import(
  '../queries/certificates'
)
const { approverEmails, checkCsr, generateCsr } = await import('../queries/supplier')

function chain(result: unknown) {
  const node = Object.assign(Promise.resolve(result), {} as Record<string, unknown>)
  for (const method of ['select', 'eq', 'order', 'in', 'limit']) node[method] = () => node
  node.maybeSingle = async () => result
  return node
}

function service(tables: Record<string, unknown>, rpc: unknown = { data: false, error: null }) {
  vi.mocked(createServiceClient).mockReturnValue({
    from: (table: string) => chain(tables[table]),
    rpc: vi.fn(async () => rpc),
  } as never)
}

const ROW = {
  product_code: '351',
  name: 'Sectigo PositiveSSL Certificate',
  vendor: 'Sectigo',
  validation_type: 'DV',
  is_wildcard: false,
  is_multi_domain: false,
  included_names: 1,
  is_reissue_free: true,
  create_usd: '6.99',
}

beforeEach(() => vi.clearAllMocks())

describe('the SSL catalogue (FR-SSL-2, N5b)', () => {
  it('prices sold products from the rate and margin, and leaves out ones not yet synced', async () => {
    service({
      fx_rates: { data: { id: 'rate-1', costing_rate: 1500, buffer_pct: 0 }, error: null },
      pricing_settings: {
        data: { margin_ngn: 3000, icann_fee_usd: 0.2, vat_pct: 7.5 },
        error: null,
      },
      ssl_products: {
        data: [
          ROW,
          { ...ROW, product_code: '352', name: null, is_wildcard: null },
          { ...ROW, product_code: '371', create_usd: null },
        ],
        error: null,
      },
    })
    const catalogue = await readSslCatalogue()
    expect(
      catalogue?.products.map((product) => [product.productCode, product.price.priceKobo]),
    ).toEqual([['351', 1_350_000]])
    expect(catalogue).toMatchObject({ rateId: 'rate-1', vatPct: 7.5 })
    expect(catalogue?.version).toMatch(/^[0-9a-f]{16}$/)
  })

  it('withholds every price without a rate or settings, and throws on a failed read', async () => {
    service({
      fx_rates: { data: null, error: null },
      pricing_settings: { data: {}, error: null },
      ssl_products: { data: [], error: null },
    })
    await expect(readSslCatalogue()).resolves.toBeNull()
    service({
      fx_rates: { data: null, error: null },
      pricing_settings: { data: null, error: null },
      ssl_products: { data: null, error: { message: 'relation does not exist' } },
    })
    await expect(readSslCatalogue()).rejects.toThrow('ssl_products: relation does not exist')
    await expect(getSslCatalogue()).resolves.toBeNull()
  })

  it('sells nothing, without failing, on a database without migration 39', async () => {
    for (const code of ['PGRST205', '42P01']) {
      service({
        fx_rates: { data: { id: 'rate-1', costing_rate: 1500, buffer_pct: 0 }, error: null },
        pricing_settings: { data: { margin_ngn: 3000, vat_pct: 7.5 }, error: null },
        ssl_products: { data: null, error: { code, message: 'no such table' } },
      })
      await expect(readSslCatalogue()).resolves.toBeNull()
    }
  })
})

describe('whether a name is taken', () => {
  it('asks on the side payments are taken on, and returns null when it cannot', async () => {
    service({}, { data: true, error: null })
    await expect(sslNameInUse('example.com')).resolves.toBe(true)
    service({}, { data: null, error: { code: 'X', message: 'down' } })
    await expect(sslNameInUse('example.com')).resolves.toBeNull()
  })
})

describe('certificates, read as their owner', () => {
  function user(result: unknown) {
    vi.mocked(createClient).mockResolvedValue({ from: () => chain(result) } as never)
  }

  it('lists them, or says it could not', async () => {
    user({ data: [{ id: 'c1' }], error: null })
    await expect(listMyCertificates()).resolves.toEqual([{ id: 'c1' }])
    user({ data: null, error: { message: 'x' } })
    await expect(listMyCertificates()).resolves.toBeNull()
  })

  it('reads one by id, refusing what is not an id', async () => {
    user({ data: { id: '6f1c2a4e-0b7d-4c1e-9a55-2d8f0e3b7c10' } })
    await expect(getMyCertificate('6f1c2a4e-0b7d-4c1e-9a55-2d8f0e3b7c10')).resolves.toMatchObject({
      id: expect.any(String),
    })
    await expect(getMyCertificate('not-an-id')).resolves.toBeNull()
  })

  it('maps an order’s lines to their certificates', async () => {
    user({ data: [{ id: 'c1', order_item_id: 'line-1', product_name: 'P', status: 'pending' }] })
    const map = await getOrderCertificates(['line-1'])
    expect(map.get('line-1')).toMatchObject({ id: 'c1' })
    await expect(getOrderCertificates([])).resolves.toEqual(new Map())
  })
})

describe('the set-up’s reads through the gateway (N1)', () => {
  it('asks the gateway, never the supplier, and reads its answers', async () => {
    await expect(approverEmails('*.example.com', '352')).resolves.toEqual({
      ok: true,
      data: { emails: expect.arrayContaining(['admin@example.com']) },
    })
    await expect(checkCsr('-----BEGIN CERTIFICATE REQUEST-----')).resolves.toMatchObject({
      ok: true,
      data: { commonName: 'shop.example.com' },
    })
    await expect(
      generateCsr({
        name: 'example.com',
        alternativeNames: [],
        country: 'NG',
        state: 'Lagos',
        locality: 'Ikeja',
        organization: 'X',
        organizationUnit: 'IT',
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { privateKey: expect.stringContaining('PRIVATE KEY') },
    })
  })

  it('passes on the gateway’s refusal, and calls an unreadable answer one', async () => {
    server.use(
      http.post('*/v1/ssl/csr/check', () =>
        HttpResponse.json(
          { ok: false, code: 'CSR_INVALID', message: 'bad', retryable: false },
          { status: 422 },
        ),
      ),
    )
    await expect(checkCsr('x')).resolves.toEqual({
      ok: false,
      code: 'CSR_INVALID',
      retryable: false,
    })
    server.use(
      http.get('*/v1/ssl/approvers', () => HttpResponse.json({ ok: true, data: { mails: [] } })),
    )
    await expect(approverEmails('example.com', '351')).resolves.toEqual({
      ok: false,
      code: 'UNREADABLE',
      retryable: true,
    })
  })
})
