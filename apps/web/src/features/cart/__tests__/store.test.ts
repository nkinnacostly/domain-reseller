import { beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { hashCartToken } from '../lib/token'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))
const jar = { get: vi.fn() }
vi.mock('next/headers', () => ({ cookies: async () => jar }))

const store = await import('../queries/store')

type Answer = { data?: unknown; error?: unknown; count?: number | null }
type Step = [string, ...unknown[]]

/**
 * A stand-in for the service-role Supabase client. Each `from(table)` takes
 * the next queued answer for that table and records the chain of calls made
 * on it, so a test can say which cart a query was scoped to.
 */
function fakeService(answers: Record<string, Answer[]> = {}) {
  const queries: { table: string; steps: Step[] }[] = []
  const rpc = vi.fn(
    async (_name: string, _args: unknown) => answers.rpc?.shift() ?? { error: null },
  )
  const from = (table: string) => {
    const answer = answers[table]?.shift() ?? { data: null, error: null }
    const steps: Step[] = []
    queries.push({ table, steps })
    const query = Promise.resolve(answer) as Promise<Answer> & Record<string, unknown>
    for (const method of ['select', 'eq', 'order', 'insert', 'upsert', 'update', 'delete']) {
      query[method] = (...args: unknown[]) => {
        steps.push([method, ...args])
        return query
      }
    }
    for (const method of ['single', 'maybeSingle']) {
      query[method] = () => {
        steps.push([method])
        return Promise.resolve(answer)
      }
    }
    return query
  }
  vi.mocked(createServiceClient).mockReturnValue({ from, rpc } as never)
  return { queries, rpc }
}

function signedIn(user: { id: string } | null) {
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user } }) },
  } as never)
}

const ROW = {
  id: 'line-1',
  domain: 'getpaid.com',
  tld: 'com',
  period_years: 2,
  privacy: true,
  auto_renew: false,
  // PostgREST returns bigint columns as strings.
  quoted_total_kobo: '3710000',
  quoted_renewal_kobo: '1870000',
  quoted_at: '2026-09-23T10:00:00.000Z',
}

beforeEach(() => {
  vi.resetAllMocks()
  jar.get.mockReturnValue(undefined)
  signedIn(null)
})

describe('currentOwner — who is shopping', () => {
  it('is the signed-in user, keeping any anonymous cookie so it can be merged', async () => {
    signedIn({ id: 'user-1' })
    jar.get.mockReturnValue({ value: 'anon-token' })
    expect(await store.currentOwner()).toEqual({
      owner: { kind: 'user', userId: 'user-1' },
      anonToken: 'anon-token',
    })
    expect(jar.get).toHaveBeenCalledWith('dr_cart')
  })

  it('is the anonymous cart, found by the hash of its cookie and never the token itself', async () => {
    jar.get.mockReturnValue({ value: 'anon-token' })
    const { owner, anonToken } = await store.currentOwner()
    expect(owner).toEqual({ kind: 'anon', tokenHash: hashCartToken('anon-token') })
    expect(JSON.stringify(owner)).not.toContain('anon-token')
    expect(anonToken).toBe('anon-token')
  })

  it('is nobody before the first thing is added', async () => {
    expect(await store.currentOwner()).toEqual({ owner: null, anonToken: null })
  })
})

describe('findCartId', () => {
  it('finds a signed-in cart by its user', async () => {
    const { queries } = fakeService({ carts: [{ data: { id: 'cart-1' } }] })
    expect(await store.findCartId({ kind: 'user', userId: 'user-1' })).toBe('cart-1')
    expect(queries[0]?.steps).toContainEqual(['eq', 'user_id', 'user-1'])
  })

  it('finds an anonymous cart by its token hash', async () => {
    const { queries } = fakeService({ carts: [{ data: { id: 'cart-2' } }] })
    expect(await store.findCartId({ kind: 'anon', tokenHash: 'hash-1' })).toBe('cart-2')
    expect(queries[0]?.steps).toContainEqual(['eq', 'anon_token_hash', 'hash-1'])
  })

  it('is null when the owner has no cart yet', async () => {
    fakeService({ carts: [{ data: null }] })
    expect(await store.findCartId({ kind: 'user', userId: 'user-1' })).toBeNull()
  })
})

describe('findOrCreateCartId', () => {
  const user = { kind: 'user' as const, userId: 'user-1' }

  it('reuses the cart the owner already has', async () => {
    const { queries } = fakeService({ carts: [{ data: { id: 'cart-1' } }] })
    expect(await store.findOrCreateCartId(user)).toBe('cart-1')
    expect(queries).toHaveLength(1)
  })

  it('creates a cart owned by the signed-in user', async () => {
    const { queries } = fakeService({ carts: [{ data: null }, { data: { id: 'cart-new' } }] })
    expect(await store.findOrCreateCartId(user)).toBe('cart-new')
    expect(queries[1]?.steps).toContainEqual(['insert', { user_id: 'user-1' }])
  })

  it('creates an anonymous cart owned by the token hash alone', async () => {
    const { queries } = fakeService({ carts: [{ data: null }, { data: { id: 'cart-new' } }] })
    await store.findOrCreateCartId({ kind: 'anon', tokenHash: 'hash-1' })
    expect(queries[1]?.steps).toContainEqual(['insert', { anon_token_hash: 'hash-1' }])
  })

  it('uses the winner when two requests race to create the same cart', async () => {
    fakeService({
      carts: [
        { data: null },
        { data: null, error: { code: '23505', message: 'duplicate key' } },
        { data: { id: 'cart-won' } },
      ],
    })
    expect(await store.findOrCreateCartId(user)).toBe('cart-won')
  })

  it('throws the database error when the cart can be neither made nor found', async () => {
    const error = { code: '08006', message: 'connection failure' }
    fakeService({ carts: [{ data: null }, { data: null, error }, { data: null }] })
    await expect(store.findOrCreateCartId(user)).rejects.toBe(error)
  })

  it('still throws when the insert fails without saying why', async () => {
    fakeService({ carts: [{ data: null }, { data: null, error: null }, { data: null }] })
    await expect(store.findOrCreateCartId(user)).rejects.toThrow('Could not create cart')
  })
})

describe('loadLines', () => {
  it('reads one cart’s lines in the order they were added, with money as numbers', async () => {
    const { queries } = fakeService({ cart_items: [{ data: [ROW] }] })
    expect(await store.loadLines('cart-1')).toEqual([
      {
        id: 'line-1',
        domain: 'getpaid.com',
        tld: 'com',
        periodYears: 2,
        privacy: true,
        autoRenew: false,
        quotedTotalKobo: 3_710_000,
        quotedRenewalKobo: 1_870_000,
        quotedAt: '2026-09-23T10:00:00.000Z',
      },
    ])
    expect(queries[0]?.steps).toContainEqual(['eq', 'cart_id', 'cart-1'])
    expect(queries[0]?.steps).toContainEqual(['order', 'created_at'])
  })

  it('is empty when the query returns no rows', async () => {
    fakeService({ cart_items: [{ data: null }] })
    expect(await store.loadLines('cart-1')).toEqual([])
  })

  it('throws rather than showing a read failure as an empty cart', async () => {
    const error = { message: 'fetch failed' }
    fakeService({ cart_items: [{ data: null, error }] })
    await expect(store.loadLines('cart-1')).rejects.toBe(error)
  })
})

describe('countLines', () => {
  it('counts one cart’s lines without reading them', async () => {
    const { queries } = fakeService({ cart_items: [{ count: 3 }] })
    expect(await store.countLines('cart-1')).toBe(3)
    expect(queries[0]?.steps).toContainEqual(['select', 'id', { count: 'exact', head: true }])
    expect(queries[0]?.steps).toContainEqual(['eq', 'cart_id', 'cart-1'])
  })

  it('is zero when no count comes back', async () => {
    fakeService({ cart_items: [{ count: null }] })
    expect(await store.countLines('cart-1')).toBe(0)
  })
})

describe('insertLine', () => {
  const line = {
    domain: 'getpaid.com',
    tld: 'com',
    periodYears: 1,
    quotedTotalKobo: 1_840_000,
    quotedRenewalKobo: 1_870_000,
    quotedFxRateId: 'rate-1',
  }

  it('adds the line with its quote, and treats a domain already there as done', async () => {
    const { queries } = fakeService({ cart_items: [{ error: null }] })
    await store.insertLine('cart-1', line)
    expect(queries[0]?.steps).toEqual([
      [
        'upsert',
        {
          cart_id: 'cart-1',
          domain: 'getpaid.com',
          tld: 'com',
          period_years: 1,
          quoted_total_kobo: 1_840_000,
          quoted_renewal_kobo: 1_870_000,
          quoted_fx_rate_id: 'rate-1',
        },
        { onConflict: 'cart_id,domain', ignoreDuplicates: true },
      ],
    ])
  })

  it('throws when the line cannot be written', async () => {
    const error = { message: 'violates check constraint' }
    fakeService({ cart_items: [{ error }] })
    await expect(store.insertLine('cart-1', line)).rejects.toBe(error)
  })
})

describe('updateLine and deleteLine — only ever inside the named cart', () => {
  it('updates a line scoped to its cart', async () => {
    const { queries } = fakeService({ cart_items: [{ error: null }] })
    await store.updateLine('cart-1', 'line-1', { privacy: false })
    expect(queries[0]?.steps).toEqual([
      ['update', { privacy: false }],
      ['eq', 'cart_id', 'cart-1'],
      ['eq', 'id', 'line-1'],
    ])
  })

  it('throws when an update fails', async () => {
    const error = { message: 'fetch failed' }
    fakeService({ cart_items: [{ error }] })
    await expect(store.updateLine('cart-1', 'line-1', { privacy: false })).rejects.toBe(error)
  })

  it('deletes a line scoped to its cart', async () => {
    const { queries } = fakeService({ cart_items: [{ error: null }] })
    await store.deleteLine('cart-1', 'line-1')
    expect(queries[0]?.steps).toEqual([
      ['delete'],
      ['eq', 'cart_id', 'cart-1'],
      ['eq', 'id', 'line-1'],
    ])
  })

  it('throws when a delete fails', async () => {
    const error = { message: 'fetch failed' }
    fakeService({ cart_items: [{ error }] })
    await expect(store.deleteLine('cart-1', 'line-1')).rejects.toBe(error)
  })
})

describe('mergeAnonymousCart', () => {
  it('moves the anonymous cart into the account in one database call, by token hash', async () => {
    const { rpc } = fakeService()
    await store.mergeAnonymousCart('anon-token', 'user-1')
    expect(rpc).toHaveBeenCalledWith('merge_anonymous_cart', {
      p_token_hash: hashCartToken('anon-token'),
      p_user_id: 'user-1',
    })
  })

  it('leaves the anonymous cart intact, and logs, when the merge fails', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    fakeService({ rpc: [{ error: { message: 'deadlock detected' } }] })
    await expect(store.mergeAnonymousCart('anon-token', 'user-1')).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith(
      { err: { message: 'deadlock detected' } },
      'cart merge failed',
    )
  })
})

describe('SSL certificate lines (FR-SSL-6, migration 39)', () => {
  it('loads a cart’s certificates as numbers, oldest first', async () => {
    const { queries } = fakeService({
      cart_ssl_items: [
        {
          data: [
            {
              id: 's1',
              product_code: '351',
              common_name: '*.example.com',
              quoted_total_kobo: '13500000',
              quoted_at: 'x',
            },
          ],
        },
      ],
    })
    await expect(store.loadSslLines('cart-1')).resolves.toEqual([
      {
        id: 's1',
        productCode: '351',
        commonName: '*.example.com',
        quotedTotalKobo: 13_500_000,
        quotedAt: 'x',
      },
    ])
    expect(queries[0]?.steps).toContainEqual(['eq', 'cart_id', 'cart-1'])
    fakeService({ cart_ssl_items: [{ data: null, error: new Error('down') }] })
    await expect(store.loadSslLines('cart-1')).rejects.toThrow('down')
  })

  it('reads a database without migration 39 as a cart with no certificates', async () => {
    fakeService({
      cart_ssl_items: [{ data: null, error: { code: 'PGRST205', message: 'no table' } }],
    })
    await expect(store.loadSslLines('cart-1')).resolves.toEqual([])
  })

  it('adds a certificate once per name, re-quotes and removes it within the cart', async () => {
    const { queries } = fakeService()
    await store.insertSslLine('cart-1', {
      productCode: '351',
      commonName: 'example.com',
      quotedTotalKobo: 1,
      quotedFxRateId: 'rate-1',
    })
    await store.requoteSslLine('cart-1', 's1', {
      quoted_total_kobo: 2,
      quoted_fx_rate_id: 'rate-1',
      quoted_at: 'now',
    })
    await store.deleteSslLine('cart-1', 's1')
    expect(queries[0]?.steps[0]).toEqual([
      'upsert',
      {
        cart_id: 'cart-1',
        product_code: '351',
        common_name: 'example.com',
        quoted_total_kobo: 1,
        quoted_fx_rate_id: 'rate-1',
      },
      { onConflict: 'cart_id,common_name', ignoreDuplicates: true },
    ])
    expect(queries[1]?.steps).toContainEqual(['eq', 'id', 's1'])
    expect(queries[2]?.steps).toContainEqual(['delete'])
    expect(queries[2]?.steps).toContainEqual(['eq', 'cart_id', 'cart-1'])
  })

  it('passes a failed write on', async () => {
    fakeService({
      cart_ssl_items: [
        { error: new Error('a') },
        { error: new Error('b') },
        { error: new Error('c') },
      ],
    })
    await expect(
      store.insertSslLine('c', {
        productCode: '1',
        commonName: 'a.com',
        quotedTotalKobo: 1,
        quotedFxRateId: 'r',
      }),
    ).rejects.toThrow('a')
    await expect(
      store.requoteSslLine('c', 'l', {
        quoted_total_kobo: 1,
        quoted_fx_rate_id: 'r',
        quoted_at: 'n',
      }),
    ).rejects.toThrow('b')
    await expect(store.deleteSslLine('c', 'l')).rejects.toThrow('c')
  })

  it('counts domains and certificates together for the badge and the cap', async () => {
    fakeService({ cart_items: [{ count: 2 }], cart_ssl_items: [{ count: 1 }] })
    await expect(store.countLines('cart-1')).resolves.toBe(3)
    fakeService({ cart_items: [{ count: null }], cart_ssl_items: [{ count: null }] })
    await expect(store.countLines('cart-1')).resolves.toBe(0)
  })
})
