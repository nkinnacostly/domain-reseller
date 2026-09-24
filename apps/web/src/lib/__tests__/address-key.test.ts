import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }))
vi.mock('next/headers', () => ({ headers: async () => requestHeaders.current }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))

const { addressKey, LIMITS } = await import('../rate-limit')

const { clientKey } = await import('../client-ip')
/** Keyed with the server's secret, so a table of hashes cannot be reversed by trying every IPv4. */
const hashed = (value: string) => clientKey(new Headers({ 'x-real-ip': value }))

beforeEach(() => {
  requestHeaders.current = new Headers()
})

describe('addressKey', () => {
  it('never holds the address as written, only a hash of it', async () => {
    requestHeaders.current = new Headers({ 'x-real-ip': '102.89.1.2' })
    const key = await addressKey('bulk_search')
    expect(key).toBe(`bulk_search:${hashed('102.89.1.2')}`)
    expect(key).not.toContain('102.89')
  })

  it('counts every caller without an address together', async () => {
    expect(await addressKey('bulk_search')).toBe(`bulk_search:${clientKey(new Headers())}`)
    requestHeaders.current = new Headers()
    expect(await addressKey('bulk_search')).toBe(await addressKey('bulk_search'))
  })

  it('is not a plain hash of the address', async () => {
    const { createHash } = await import('node:crypto')
    requestHeaders.current = new Headers({ 'x-real-ip': '102.89.1.2' })
    const plain = createHash('sha256').update('102.89.1.2').digest('hex').slice(0, 32)
    expect(await addressKey('bulk_search')).not.toBe(`bulk_search:${plain}`)
  })

  it('keeps one scope apart from another', async () => {
    requestHeaders.current = new Headers({ 'x-forwarded-for': '102.89.1.2' })
    expect(await addressKey('bulk_add')).not.toBe(await addressKey('bulk_search'))
  })
})

describe('bulk limits (FR-S5)', () => {
  it('limit bulk searches and bulk adds per address, over minutes', () => {
    expect(LIMITS.bulkSearch).toEqual({ max: 24, windowSeconds: 600 })
    expect(LIMITS.bulkAddToCart).toEqual({ max: 20, windowSeconds: 600 })
  })

  it('let one 500-name list through, with room to retry, but not three in ten minutes', () => {
    // Counted per block of 50 names (actions/bulk.ts).
    const blocksPerList = 500 / 50
    expect(LIMITS.bulkSearch.max).toBeGreaterThan(blocksPerList)
    expect(LIMITS.bulkSearch.max).toBeLessThan(blocksPerList * 3)
  })
})
