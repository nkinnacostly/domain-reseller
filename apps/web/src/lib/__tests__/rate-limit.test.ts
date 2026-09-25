import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createServiceClient } from '@/lib/supabase/service'

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))

const { LIMITS, withinLimit } = await import('../rate-limit')

function answer(result: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn(async () => result)
  vi.mocked(createServiceClient).mockReturnValue({ rpc } as never)
  return rpc
}

beforeEach(() => vi.clearAllMocks())

describe('withinLimit (SEC-11)', () => {
  it('counts the hit in the database under the given key and window', async () => {
    const rpc = answer({ data: true, error: null })
    expect(await withinLimit('place_order:user-1', LIMITS.placeOrder)).toBe(true)
    expect(rpc).toHaveBeenCalledWith('rate_limit_hit', {
      p_key: 'place_order:user-1',
      p_max: LIMITS.placeOrder.max,
      p_window_seconds: LIMITS.placeOrder.windowSeconds,
    })
  })

  it('refuses once the window is full', async () => {
    answer({ data: false, error: null })
    expect(await withinLimit('k', LIMITS.placeOrder)).toBe(false)
  })

  it('fails closed when the count cannot be read', async () => {
    answer({ data: null, error: { message: 'db down' } })
    expect(await withinLimit('k', LIMITS.checkoutReturn)).toBe(false)
  })

  it('only a clear yes lets the action through', async () => {
    answer({ data: 'true', error: null })
    expect(await withinLimit('k', LIMITS.placeOrder)).toBe(false)
  })
})

describe('search limits (SEC-9)', () => {
  it('give a person thirty searches in ten minutes, and ten times that with a pass', () => {
    expect(LIMITS.search).toEqual({ max: 30, windowSeconds: 600 })
    expect(LIMITS.searchWithPass.max).toBe(LIMITS.search.max * 10)
  })

  it('share one window, since both judge the same count', () => {
    // rate_limit_hit keys its window by the seconds given: different ones would split the count.
    expect(LIMITS.searchWithPass.windowSeconds).toBe(LIMITS.search.windowSeconds)
  })
})
