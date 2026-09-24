import { describe, expect, it, vi } from 'vitest'
import { createPriceRefresh } from './refresh'

/** Prices are already written when this runs: it may fail, but never throws. */

describe('asking the site to refresh its prices', () => {
  it('says so when the site could not be reached, without throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(createPriceRefresh('https://www.mydomainshub.com', fetchImpl)()).resolves.toBe(
      false,
    )
  })

  it('says so when the site refused', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":false}', { status: 429 }))
    await expect(createPriceRefresh('https://www.mydomainshub.com', fetchImpl)()).resolves.toBe(
      false,
    )
  })

  it('posts to the refresh route, with a time limit', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ ok: true, refreshed: true }),
    )
    await expect(createPriceRefresh('https://www.mydomainshub.com/', fetchImpl)()).resolves.toBe(
      true,
    )
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(String(url)).toBe('https://www.mydomainshub.com/api/pricing/refresh')
    expect(init?.method).toBe('POST')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })
})
