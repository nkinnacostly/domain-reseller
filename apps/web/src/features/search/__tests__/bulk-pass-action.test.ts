import { type PricingInputs, priceCatalogue, type TldRecord } from '@dr/shared'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { signHumanPass } from '../lib/human-pass'

/** The request being served, and the rate-limit table's answer. */
const request = vi.hoisted(() => ({
  headers: new Headers(),
  pass: undefined as string | undefined,
  rpc: null as unknown as Mock,
}))

vi.mock('next/headers', () => ({
  headers: async () => request.headers,
  cookies: async () => ({
    get: (name: string) =>
      name === 'dr_search_pass' && request.pass ? { name, value: request.pass } : undefined,
  }),
}))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ rpc: request.rpc }) }))
vi.mock('@/features/pricing/queries/pricing', () => ({ getPricedCatalogue: vi.fn() }))
vi.mock('../queries/availability', () => ({ checkAvailability: vi.fn() }))
vi.mock('../queries/length-rules', () => ({ getLengthRules: async () => ({}) }))

const SECRET = 'sb_secret_test_only'
const INPUTS: PricingInputs = { fxRate: 1333.76, fxBufferPct: 0, marginNgn: 3000, icannFeeUsd: 0.2 }
const record: TldRecord = {
  name: 'com',
  registerUsd: 11.31,
  renewUsd: 12.5,
  transferUsd: null,
  restoreUsd: null,
  isCountryCode: false,
  minPeriod: 1,
  maxPeriod: 10,
  redemptionDays: 30,
  requiresExtraFields: false,
}

/** env.ts reads process.env once, at import — so each case loads the modules fresh. */
async function load(turnstile = true) {
  vi.resetModules()
  vi.stubEnv('SUPABASE_SECRET_KEY', SECRET)
  vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', turnstile ? 'site-key' : undefined)
  vi.stubEnv('TURNSTILE_SECRET_KEY', turnstile ? 'secret-key' : undefined)
  const { getPricedCatalogue } = await import('@/features/pricing/queries/pricing')
  const { checkAvailability } = await import('../queries/availability')
  const tlds = priceCatalogue([record], INPUTS)
  vi.mocked(getPricedCatalogue).mockResolvedValue({
    tlds,
    featured: [],
    effectiveRate: 1334,
    rateSource: 'test',
    rateUpdatedAt: new Date(),
    rateId: 'rate-1',
    vatPct: 7.5,
    version: 'test',
  })
  vi.mocked(checkAvailability).mockImplementation(async (names, extensions) => ({
    ok: true,
    results: names.flatMap((name) =>
      extensions.map((tld) => ({
        name,
        tld,
        domain: `${name}.${tld}`,
        status: 'available' as const,
      })),
    ),
  }))
  const { clientKey } = await import('@/lib/client-ip')
  const { checkBulkNames } = await import('../actions/bulk')
  return {
    checkBulkNames,
    checkAvailability: vi.mocked(checkAvailability),
    me: clientKey(request.headers),
  }
}

beforeEach(() => {
  request.headers = new Headers({ 'x-real-ip': '102.89.1.2' })
  request.pass = undefined
  request.rpc = vi.fn(async () => ({ data: true, error: null }))
})
afterEach(() => vi.unstubAllEnvs())

describe('checkBulkNames — the search pass (SEC-9)', () => {
  it('with Turnstile on, starts nothing without a pass: no count, no supplier call', async () => {
    const { checkBulkNames, checkAvailability } = await load()

    const result = await checkBulkNames({ names: ['getpaid'], tlds: ['com'] })

    expect(result?.data).toEqual({ ok: false, reason: 'unconfirmed' })
    expect(request.rpc).not.toHaveBeenCalled()
    expect(checkAvailability).not.toHaveBeenCalled()
  })

  it.each([
    ['forged', (me: string) => signHumanPass('guessed-secret', me, Math.floor(Date.now() / 1000))],
    [
      "another connection's",
      () =>
        signHumanPass(SECRET, 'ffffffffffffffffffffffffffffffff', Math.floor(Date.now() / 1000)),
    ],
    ['expired', (me: string) => signHumanPass(SECRET, me, Math.floor(Date.now() / 1000) - 7_201)],
  ])('treats a %s pass as none', async (_case, make) => {
    const { checkBulkNames, checkAvailability, me } = await load()
    request.pass = make(me)

    const result = await checkBulkNames({ names: ['getpaid'], tlds: ['com'] })

    expect(result?.data).toEqual({ ok: false, reason: 'unconfirmed' })
    expect(checkAvailability).not.toHaveBeenCalled()
  })

  it('with a pass from this connection, checks the block as before', async () => {
    const { checkBulkNames, checkAvailability, me } = await load()
    request.pass = signHumanPass(SECRET, me, Math.floor(Date.now() / 1000))

    const result = await checkBulkNames({ names: ['getpaid'], tlds: ['com'] })

    expect(result?.data).toMatchObject({ ok: true, results: [{ domain: 'getpaid.com' }] })
    expect(checkAvailability).toHaveBeenCalledTimes(1)
    expect(request.rpc).toHaveBeenCalledWith(
      'rate_limit_hit',
      expect.objectContaining({ p_key: `bulk_search:${me}` }),
    )
  })

  it('with Turnstile off, asks for no pass', async () => {
    const { checkBulkNames, checkAvailability } = await load(false)

    const result = await checkBulkNames({ names: ['getpaid'], tlds: ['com'] })

    expect(result?.data).toMatchObject({ ok: true })
    expect(checkAvailability).toHaveBeenCalledTimes(1)
  })
})
