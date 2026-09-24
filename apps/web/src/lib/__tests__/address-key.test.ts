import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }))
vi.mock('next/headers', () => ({ headers: async () => requestHeaders.current }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))

const { addressKey, LIMITS } = await import('../rate-limit')

const hashed = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32)

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
    expect(await addressKey('bulk_search')).toBe(`bulk_search:${hashed('unknown')}`)
  })

  it('keeps one scope apart from another', async () => {
    requestHeaders.current = new Headers({ 'x-forwarded-for': '102.89.1.2' })
    expect(await addressKey('bulk_add')).not.toBe(await addressKey('bulk_search'))
  })
})

describe('bulk limits (FR-S5)', () => {
  it('limit bulk searches and bulk adds per address, over minutes', () => {
    expect(LIMITS.bulkSearch).toEqual({ max: 20, windowSeconds: 600 })
    expect(LIMITS.bulkAddToCart).toEqual({ max: 20, windowSeconds: 600 })
  })
})
