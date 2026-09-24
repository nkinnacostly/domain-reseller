import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addressKey, withinLimit } from '@/lib/rate-limit'

vi.mock('@/lib/rate-limit', async (original) => ({
  ...(await original<typeof import('@/lib/rate-limit')>()),
  addressKey: vi.fn(async (scope: string) => `${scope}:hashed`),
  withinLimit: vi.fn(),
}))

const { bulkSearchAllowed } = await import('../queries/bulk-allowance')
const { LIMITS } = await import('@/lib/rate-limit')

beforeEach(() => vi.clearAllMocks())

describe('bulkSearchAllowed (FR-S5)', () => {
  it('refuses once this address has run its share of bulk searches', async () => {
    vi.mocked(withinLimit).mockResolvedValue(false)
    expect(await bulkSearchAllowed()).toBe(false)
  })

  it('counts the search against the caller’s address', async () => {
    vi.mocked(withinLimit).mockResolvedValue(true)
    expect(await bulkSearchAllowed()).toBe(true)
    expect(addressKey).toHaveBeenCalledWith('bulk_search')
    expect(withinLimit).toHaveBeenCalledWith('bulk_search:hashed', LIMITS.bulkSearch)
  })
})
