import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import {
  countHeldDomains,
  getTwoFactorRequirement,
  mustTurnOnTwoFactor,
} from '../queries/two-factor'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

type Answer = { count: number | null; error: { message: string } | null }

/**
 * The signed-in person's client (RLS): a count of their domains, their
 * authenticators, and the profile getAccount reads. Every filter on the
 * count is recorded, so the test can say what "held" means.
 */
function client({
  held = { count: 3, error: null } as Answer,
  totp = [] as { id: string; status: string }[],
  factorsError = null as { message: string } | null,
  user = { id: 'user-1', email: 'ada@example.com' } as { id: string; email: string } | null,
} = {}) {
  const filters: unknown[][] = []
  const count = Object.assign(Promise.resolve(held), {} as Record<string, unknown>)
  for (const method of ['select', 'eq', 'neq', 'not']) {
    count[method] = (...args: unknown[]) => {
      filters.push([method, ...args])
      return count
    }
  }
  const profile = {
    select: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }),
  }
  const listFactors = vi.fn(async () =>
    factorsError ? { data: null, error: factorsError } : { data: { totp }, error: null },
  )
  const fake = {
    auth: {
      getUser: async () => ({ data: { user } }),
      mfa: {
        listFactors,
        getAuthenticatorAssuranceLevel: async () => ({ data: null }),
      },
    },
    from: vi.fn((table: string) => (table === 'domains' ? count : profile)),
  }
  vi.mocked(createClient).mockResolvedValue(fake as never)
  return { fake, filters, listFactors }
}

const session = async () => createClient()

beforeEach(() => vi.clearAllMocks())

describe('countHeldDomains (FR-A2)', () => {
  it('counts the account’s own real domains that are still held — no demo rows', async () => {
    const { fake, filters } = client({ held: { count: 11, error: null } })
    expect(await countHeldDomains(await session(), 'user-1')).toBe(11)
    expect(fake.from).toHaveBeenCalledWith('domains')
    expect(filters).toEqual([
      ['select', 'id', { count: 'exact', head: true }],
      ['eq', 'user_id', 'user-1'],
      ['neq', 'source', 'demo'],
      [
        'not',
        'local_status',
        'in',
        '(released,transferred_away,registration_failed,transfer_rejected,transfer_cancelled,closed)',
      ],
    ])
  })

  it('answers null when the count cannot be read', async () => {
    client({ held: { count: null, error: { message: 'db down' } } })
    expect(await countHeldDomains(await session(), 'user-1')).toBeNull()
    client({ held: { count: null, error: null } })
    expect(await countHeldDomains(await session(), 'user-1')).toBeNull()
  })
})

describe('mustTurnOnTwoFactor', () => {
  it('leaves an account at ten domains alone, without reading its authenticators', async () => {
    const { listFactors } = client({ held: { count: 10, error: null } })
    expect(await mustTurnOnTwoFactor(await session(), 'user-1')).toBe(false)
    expect(listFactors).not.toHaveBeenCalled()
  })

  it('holds back an account above ten with no confirmed authenticator', async () => {
    client({ held: { count: 11, error: null }, totp: [{ id: 'f', status: 'unverified' }] })
    expect(await mustTurnOnTwoFactor(await session(), 'user-1')).toBe(true)
  })

  it('lets an account above ten through once two-factor is on', async () => {
    client({ held: { count: 40, error: null }, totp: [{ id: 'f', status: 'verified' }] })
    expect(await mustTurnOnTwoFactor(await session(), 'user-1')).toBe(false)
  })

  it('cannot tell — null — when the count or the authenticators cannot be read', async () => {
    client({ held: { count: null, error: { message: 'db down' } } })
    expect(await mustTurnOnTwoFactor(await session(), 'user-1')).toBeNull()
    client({ held: { count: 11, error: null }, factorsError: { message: 'auth down' } })
    expect(await mustTurnOnTwoFactor(await session(), 'user-1')).toBeNull()
  })
})

describe('getTwoFactorRequirement — what the panel shows', () => {
  it('has nothing to say to a signed-out visitor', async () => {
    const { fake } = client({ user: null })
    expect(await getTwoFactorRequirement()).toBeNull()
    expect(fake.from).not.toHaveBeenCalledWith('domains')
  })

  it('reports the count, whether the rule applies, and whether two-factor is on', async () => {
    client({ held: { count: 11, error: null } })
    expect(await getTwoFactorRequirement()).toEqual({ held: 11, required: true, hasFactor: false })
    client({ held: { count: 11, error: null }, totp: [{ id: 'f', status: 'verified' }] })
    expect(await getTwoFactorRequirement()).toEqual({ held: 11, required: true, hasFactor: true })
    client({ held: { count: 2, error: null } })
    expect(await getTwoFactorRequirement()).toEqual({ held: 2, required: false, hasFactor: false })
  })

  it('shows nothing rather than a guess when the domains cannot be counted', async () => {
    client({ held: { count: null, error: { message: 'db down' } } })
    expect(await getTwoFactorRequirement()).toBeNull()
  })
})
