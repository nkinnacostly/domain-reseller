import { revalidateTag } from 'next/cache'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadPricedCatalogue, readPricedCatalogue } from '@/features/pricing/queries/pricing'
import { withinLimit } from '@/lib/rate-limit'

vi.mock('next/cache', () => ({ revalidateTag: vi.fn() }))
vi.mock('@/features/pricing/queries/pricing', () => ({
  loadPricedCatalogue: vi.fn(),
  readPricedCatalogue: vi.fn(),
}))
vi.mock('@/lib/rate-limit', async (original) => ({
  ...(await original<typeof import('@/lib/rate-limit')>()),
  withinLimit: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }))

const { POST } = await import('@/app/api/pricing/refresh/route')

const priced = (version: string) => ({ version }) as never

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(withinLimit).mockResolvedValue(true)
})

describe('POST /api/pricing/refresh (L8)', () => {
  it('expires the cache at once when the prices in the database have changed', async () => {
    vi.mocked(loadPricedCatalogue).mockResolvedValue(priced('old'))
    vi.mocked(readPricedCatalogue).mockResolvedValue(priced('new'))
    const response = await POST()
    expect(await response.json()).toEqual({ ok: true, refreshed: true })
    expect(revalidateTag).toHaveBeenCalledWith('pricing', { expire: 0 })
  })

  it('does nothing when they have not — so a caller cannot force work', async () => {
    vi.mocked(loadPricedCatalogue).mockResolvedValue(priced('same'))
    vi.mocked(readPricedCatalogue).mockResolvedValue(priced('same'))
    expect(await (await POST()).json()).toEqual({ ok: true, refreshed: false })
    expect(revalidateTag).not.toHaveBeenCalled()
  })

  it('withdraws cached prices once the data behind them is gone', async () => {
    vi.mocked(loadPricedCatalogue).mockResolvedValue(priced('old'))
    vi.mocked(readPricedCatalogue).mockResolvedValue(null)
    expect(await (await POST()).json()).toEqual({ ok: true, refreshed: true })
  })

  it('answers 503, and keeps the cache, when the prices cannot be read', async () => {
    vi.mocked(loadPricedCatalogue).mockResolvedValue(priced('old'))
    vi.mocked(readPricedCatalogue).mockRejectedValue(new Error('fetch failed'))
    expect((await POST()).status).toBe(503)
    expect(revalidateTag).not.toHaveBeenCalled()
  })

  it('is rate-limited', async () => {
    vi.mocked(withinLimit).mockResolvedValue(false)
    expect((await POST()).status).toBe(429)
    expect(readPricedCatalogue).not.toHaveBeenCalled()
  })
})
