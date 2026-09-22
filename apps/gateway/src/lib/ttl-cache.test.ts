import { describe, expect, it } from 'vitest'
import { TtlCache } from './ttl-cache'

describe('TtlCache', () => {
  it('forgets an entry once it expires', () => {
    const cache = new TtlCache<string>(60_000, 10)
    cache.set('getpaid.com', 'available', 0)
    expect(cache.get('getpaid.com', 59_999)).toBe('available')
    expect(cache.get('getpaid.com', 60_000)).toBeUndefined()
  })

  it('evicts the oldest entry when full', () => {
    const cache = new TtlCache<number>(60_000, 2)
    cache.set('a', 1, 0)
    cache.set('b', 2, 0)
    cache.set('c', 3, 0)
    expect(cache.get('a', 1)).toBeUndefined()
    expect(cache.get('c', 1)).toBe(3)
    expect(cache.size).toBe(2)
  })

  it('empties on clear', () => {
    const cache = new TtlCache<number>(60_000, 2)
    cache.set('a', 1, 0)
    cache.clear()
    expect(cache.size).toBe(0)
  })

  it('treats a rewritten entry as the newest', () => {
    const cache = new TtlCache<number>(60_000, 2)
    cache.set('a', 1, 0)
    cache.set('b', 2, 0)
    cache.set('a', 10, 0)
    cache.set('c', 3, 0)
    expect(cache.get('a', 1)).toBe(10)
    expect(cache.get('b', 1)).toBeUndefined()
  })
})
