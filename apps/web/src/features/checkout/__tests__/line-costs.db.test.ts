import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { vatKobo } from '@dr/shared'
import { usdToCents } from '@dr/shared/admin'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { server } from '../../../../tests/mocks/server'

/**
 * B15 against the hosted project's test side (ADMIN-SPEC §6, §8, D13), opt-in
 * like the other database tests:
 *
 *   DB_TESTS=1 pnpm --filter @dr/web exec vitest run src/features/checkout/__tests__/line-costs.db.test.ts
 *
 * placeOrder (a .com, an .ai for its two-year first term, and a certificate)
 * and placeTransfer run for real against the database — the real catalogue,
 * the real `::text` reads, real orders and lines — with the network around it
 * stood in for: the cart, availability, the registry, the gateway and
 * Flutterwave. Every line inserted gets its `order_item_costs` row, in cents
 * that add up to the float pre-flight's total; the customer can read their
 * lines and none of their cost. Test-mode orders on a fresh e2e-* user, which
 * the test removes with its orders.
 */

const ROOT_ENV = join(__dirname, '../../../../../../.env')
const KEYS =
  /^(NEXT_PUBLIC_SUPABASE_URL|NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY|SUPABASE_SECRET_KEY)=(.*)$/
const PASSWORD = 'e2e-Correct-Horse-9'
const STAMP = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
const COM = `e2e-b15-${STAMP}.com`
const AI = `e2e-b15-${STAMP}.ai`

vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: vi.fn(),
}))
vi.mock('@/features/cart/queries/cart', () => ({ getCartView: vi.fn() }))
vi.mock('@/features/cart/queries/store', () => ({
  findCartId: vi.fn(),
  deleteLine: vi.fn(),
  deleteSslLine: vi.fn(),
}))
vi.mock('@/features/ssl/queries/names', () => ({ sslNameInUse: vi.fn(async () => false) }))
vi.mock('@/features/search/queries/availability', () => ({ checkAvailability: vi.fn() }))
vi.mock('@/features/pricing/queries/pricing', () => ({ getPricedCatalogue: vi.fn() }))
vi.mock('@/features/transfers/queries/rdap-lookup', () => ({
  lookupDomain: vi.fn(async () => ({ kind: 'unavailable' })),
}))
vi.mock('@/lib/flutterwave', () => ({
  createPaymentLink: vi.fn(async () => 'https://checkout.test/pay/1'),
}))
vi.mock('@/lib/gateway', () => ({ callGateway: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/env', async (original) => ({
  ...(await original<typeof import('@/lib/env')>()),
  requirePaymentEnv: vi.fn(() => ({
    secretKey: 'FLWSECK_TEST-x-X',
    publicKey: 'FLWPUBK_TEST-x-X',
    webhookHash: 'hash',
    testMode: true,
  })),
}))

/** A chainable stand-in for the customer's own client: no domains, no saved contact. */
function chain(result: unknown) {
  const node = Object.assign(Promise.resolve(result), {} as Record<string, unknown>)
  for (const method of ['select', 'eq', 'neq', 'not', 'in', 'is', 'insert', 'update']) {
    node[method] = () => node
  }
  node.single = async () => result
  node.maybeSingle = async () => result
  return node
}

type Row = Record<string, unknown>

describe.skipIf(process.env.DB_TESTS !== '1')('line costs on the hosted test side', () => {
  let db: SupabaseClient
  let customer: SupabaseClient
  let userId = ''
  let email = ''
  // biome-ignore lint/suspicious/noExplicitAny: the modules are imported after the env is set
  let m: any

  beforeAll(async () => {
    // The real network, with the real keys: MSW and the test env stand aside.
    server.close()
    for (const line of readFileSync(ROOT_ENV, 'utf8').split('\n')) {
      const match = KEYS.exec(line.trim())
      if (match?.[1] && match[2]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
    }
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
    db = createClient(url, process.env.SUPABASE_SECRET_KEY ?? '', {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    email = `e2e-b15-${STAMP}@example.com`
    const created = await db.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    })
    if (created.error || !created.data.user) throw created.error ?? new Error('no user')
    userId = created.data.user.id
    customer = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '', {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const signedIn = await customer.auth.signInWithPassword({ email, password: PASSWORD })
    if (signedIn.error) throw signedIn.error

    m = {
      placeOrder: (await import('../actions/place-order')).placeOrder,
      placeTransfer: (await import('@/features/transfers/actions/place-transfer')).placeTransfer,
      env: await import('@/lib/env'),
      logger: (await import('@/lib/logger')).logger,
      after: (await import('next/server')).after,
      getCartView: (await import('@/features/cart/queries/cart')).getCartView,
      checkAvailability: (await import('@/features/search/queries/availability')).checkAvailability,
      getPricedCatalogue: (await import('@/features/pricing/queries/pricing')).getPricedCatalogue,
      callGateway: (await import('@/lib/gateway')).callGateway,
      createServerClient: (await import('@/lib/supabase/server')).createClient,
    }
    // Checkout may be closed to everyone but the owner before launch; not for this test.
    ;(m.env.env as { CHECKOUT_ALLOWLIST?: string }).CHECKOUT_ALLOWLIST = undefined
    m.createServerClient.mockResolvedValue({
      auth: {
        getUser: async () => ({ data: { user: { id: userId, email } } }),
        mfa: { listFactors: async () => ({ data: { totp: [] }, error: null }) },
      },
      from: (table: string) =>
        table === 'domains'
          ? chain({ count: 0, error: null })
          : chain({ data: null, error: { code: 'TEST', message: 'not saved in this test' } }),
    })
    // The float is empty, so each test-mode pre-flight logs the total it checked.
    m.callGateway.mockImplementation(async ({ path }: { path: string }) =>
      path === 'transfers/check' ? { transferable: true } : { balanceUsd: 0 },
    )
    m.checkAvailability.mockImplementation(async (stems: string[], [tld]: string[]) => ({
      ok: true,
      results: stems.map((name) => ({ name, tld, domain: `${name}.${tld}`, status: 'available' })),
    }))
  }, 60_000)

  afterAll(async () => {
    if (userId) {
      await db.rpc('purge_test_orders', { p_user_id: userId })
      await db.auth.admin.deleteUser(userId)
    }
    server.listen({ onUnhandledRequest: 'error' })
  }, 60_000)

  /** Runs the action, then what it left for after the response; returns the total it checked. */
  async function place(run: () => Promise<{ data?: unknown }>): Promise<number> {
    m.after.mockClear()
    const warn = vi.spyOn(m.logger, 'warn')
    const result = await run()
    expect(result?.data).toEqual({ redirectTo: 'https://checkout.test/pay/1' })
    const checked = warn.mock.calls.find(([, message]) =>
      String(message).includes('float shortfall'),
    )?.[0] as { costUsd: number } | undefined
    warn.mockRestore()
    for (const [task] of m.after.mock.calls) await task()
    return Math.round((checked?.costUsd ?? Number.NaN) * 100)
  }

  async function catalogue() {
    const [tlds, settings, ssl] = await Promise.all([
      db
        .from('tlds')
        .select('name, register_usd::text, renew_usd::text, transfer_usd::text')
        .in('name', ['com', 'ai']),
      db.from('pricing_settings').select('icann_fee_usd::text').single(),
      db.from('ssl_products').select('create_usd::text').eq('product_code', '351').single(),
    ])
    const tld = (name: string) => (tlds.data ?? []).find((row) => row.name === name) as Row
    return {
      com: tld('com'),
      ai: tld('ai'),
      icannCents: usdToCents(String(settings.data?.icann_fee_usd)),
      sslCents: usdToCents(String(ssl.data?.create_usd)),
    }
  }

  async function linesWithCosts(orderId: string) {
    const { data: lines, error } = await db
      .from('order_items')
      .select('id, domain, item_type, period_years')
      .eq('order_id', orderId)
    expect(error).toBeNull()
    const ids = (lines ?? []).map((line) => line.id)
    const { data: costs } = await db
      .from('order_item_costs')
      .select('order_item_id, supplier_cost_cents, icann_fee_cents')
      .in('order_item_id', ids)
    return { lines: lines ?? [], costs: (costs ?? []) as Row[] }
  }

  const DOMAIN_LINE = { privacy: false, autoRenew: true, status: 'current', unsoldYears: null }

  /** Checks out one cart; its line and cost rows, and the cents the float pre-flight checked. */
  async function checkout(cart: { lines: Row[]; certificates: Row[]; payableKobo: number }) {
    const vat = vatKobo(cart.payableKobo, 7.5)
    m.getCartView.mockResolvedValue({
      state: 'ready',
      lines: cart.lines,
      certificates: cart.certificates,
      totals: {
        subtotalKobo: cart.payableKobo,
        vatKobo: vat,
        totalKobo: cart.payableKobo + vat,
        needsAcknowledgement: false,
        unavailableCount: 0,
      },
      vatPct: 7.5,
      lockMinutes: 30,
    })
    const checked = await place(() =>
      m.placeOrder({
        registrant: {
          firstName: 'Ada',
          lastName: 'Okafor',
          email,
          phoneCountryCode: '234',
          phone: '0803 123 4567',
          addressLine1: '12 Admiralty Way',
          city: 'Lagos',
          state: 'Lagos',
          zipCode: '100001',
          country: 'NG',
        },
        confirmed: true,
        expectedTotalKobo: cart.payableKobo + vat,
      }),
    )
    const { data: order } = await db
      .from('orders')
      .select('id, test_mode, float_check')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()
    expect(order).toMatchObject({ test_mode: true, float_check: 'shortfall_test_mode' })
    return { checked, ...(await linesWithCosts(String(order?.id))) }
  }

  /** The line's one cost row, in cents, adding up to what the float was checked against. */
  function expectCost(
    result: Awaited<ReturnType<typeof checkout>>,
    cents: { supplier: number; icann: number },
  ) {
    expect(result.lines).toHaveLength(1)
    expect(result.costs).toEqual([
      {
        order_item_id: result.lines[0]?.id,
        supplier_cost_cents: cents.supplier,
        icann_fee_cents: cents.icann,
      },
    ])
    expect(cents.supplier + cents.icann).toBe(result.checked)
  }

  it('costs a .com registration — its year at the register rate, ICANN apart — as checked', async () => {
    const prices = await catalogue()
    const result = await checkout({
      payableKobo: 1_840_000,
      certificates: [],
      lines: [
        {
          ...DOMAIN_LINE,
          id: 'line-com',
          domain: COM,
          tld: 'com',
          periodYears: 1,
          privacyOffered: true,
          payableKobo: 1_840_000,
          renewalKobo: 1_870_000,
          minPeriod: 1,
          registerPeriods: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
          renewYears: 1,
        },
      ],
    })
    expectCost(result, {
      supplier: usdToCents(String(prices.com.register_usd)),
      icann: prices.icannCents,
    })
  }, 60_000)

  it('costs an .ai registration — its two-year first term at the register rate — as checked', async () => {
    const prices = await catalogue()
    const result = await checkout({
      payableKobo: 27_300_000,
      certificates: [],
      lines: [
        {
          ...DOMAIN_LINE,
          id: 'line-ai',
          domain: AI,
          tld: 'ai',
          periodYears: 2,
          privacyOffered: false,
          payableKobo: 27_300_000,
          renewalKobo: 13_650_000,
          minPeriod: 2,
          registerPeriods: [2, 4, 6, 8, 10],
          renewYears: 2,
        },
      ],
    })
    expectCost(result, { supplier: 2 * usdToCents(String(prices.ai.register_usd)), icann: 0 })
  }, 60_000)

  it('costs a certificate at its product’s price, as checked', async () => {
    const prices = await catalogue()
    const result = await checkout({
      payableKobo: 1_350_000,
      lines: [],
      certificates: [
        {
          id: 'ssl-1',
          productCode: '351',
          commonName: COM,
          status: 'current',
          payableKobo: 1_350_000,
          renewalKobo: 1_350_000,
        },
      ],
    })
    expectCost(result, { supplier: prices.sslCents, icann: 0 })
  }, 60_000)

  it('takes a mixed cart — .com, a two-year .ai and a certificate — as one order', async () => {
    // Only the .ai row sets renewal_years and only the certificate sets
    // item_type; both are NOT NULL, so a key a row leaves out must take the
    // column's default. Sent as NULL, the whole insert failed (23502).
    const prices = await catalogue()
    const result = await checkout({
      payableKobo: 1_840_000 + 27_300_000 + 1_350_000,
      lines: [
        {
          ...DOMAIN_LINE,
          id: 'line-com',
          domain: COM,
          tld: 'com',
          periodYears: 1,
          privacyOffered: true,
          payableKobo: 1_840_000,
          renewalKobo: 1_870_000,
          minPeriod: 1,
          registerPeriods: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
          renewYears: 1,
        },
        {
          ...DOMAIN_LINE,
          id: 'line-ai',
          domain: AI,
          tld: 'ai',
          periodYears: 2,
          privacyOffered: false,
          payableKobo: 27_300_000,
          renewalKobo: 13_650_000,
          minPeriod: 2,
          registerPeriods: [2, 4, 6, 8, 10],
          renewYears: 2,
        },
      ],
      certificates: [
        {
          id: 'ssl-1',
          productCode: '351',
          commonName: COM,
          status: 'current',
          payableKobo: 1_350_000,
          renewalKobo: 1_350_000,
        },
      ],
    })
    expect(result.lines).toHaveLength(3)
    expect(result.costs).toHaveLength(3)
    const total = result.costs.reduce(
      (sum, row) => sum + Number(row.supplier_cost_cents) + Number(row.icann_fee_cents),
      0,
    )
    expect(total).toBe(result.checked)
    expect(total).toBe(
      usdToCents(String(prices.com.register_usd)) +
        prices.icannCents +
        2 * usdToCents(String(prices.ai.register_usd)) +
        prices.sslCents,
    )
  }, 60_000)

  it('costs a transfer as its float was checked', async () => {
    const prices = await catalogue()
    m.getPricedCatalogue.mockResolvedValue({
      vatPct: 7.5,
      tlds: [
        {
          tld: 'com',
          isCountryCode: false,
          transfer: { priceKobo: 1_700_000 },
          renewal: { priceKobo: 1_870_000 },
          renewalTerm: { years: 1, priceKobo: 1_870_000 },
        },
      ],
    })
    const domain = `e2e-b15-move-${STAMP}.com`
    const checked = await place(() =>
      m.placeTransfer({
        domain,
        authCode: 'Xk9#-transfer-CODE',
        registrant: {
          firstName: 'Ada',
          lastName: 'Okafor',
          company: '',
          email,
          phoneCountryCode: '234',
          phone: '0803 123 4567',
          addressLine1: '1 Marina',
          city: 'Lagos',
          state: 'Lagos',
          zipCode: '100001',
          country: 'NG',
        },
        expectedTotalKobo: 1_700_000 + vatKobo(1_700_000, 7.5),
      }),
    )
    const { data: line } = await db
      .from('order_items')
      .select('id, order_id')
      .eq('domain', domain)
      .eq('item_type', 'transfer')
      .single()
    const { costs } = await linesWithCosts(String(line?.order_id))
    expect(costs).toEqual([
      {
        order_item_id: line?.id,
        supplier_cost_cents: usdToCents(String(prices.com.transfer_usd)),
        icann_fee_cents: prices.icannCents,
      },
    ])
    expect(Number(costs[0]?.supplier_cost_cents) + Number(costs[0]?.icann_fee_cents)).toBe(checked)
  }, 60_000)

  it('lets the customer read their lines, and none of their cost (D13)', async () => {
    const { data: lines, error } = await customer.from('order_items').select('*').eq('domain', COM)
    expect(error).toBeNull()
    expect(lines?.length).toBeGreaterThan(0)
    for (const line of lines ?? []) {
      expect(Object.keys(line).filter((key) => /cost|cents|usd|margin/i.test(key))).toEqual([])
    }
    const costs = await customer.from('order_item_costs').select('order_item_id').limit(1)
    expect(costs.data).toBeNull()
    expect(costs.error?.code).toBe('42501')
  }, 60_000)
})
