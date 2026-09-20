import { describe, expect, it } from 'vitest'
import { TokenBucket } from './rate-limit'

describe('TokenBucket', () => {
  it('allows requests up to capacity', () => {
    const bucket = new TokenBucket(3, 1, 0)
    expect(bucket.tryConsume(1, 0)).toBe(true)
    expect(bucket.tryConsume(1, 0)).toBe(true)
    expect(bucket.tryConsume(1, 0)).toBe(true)
  })

  it('refuses once the bucket is empty', () => {
    const bucket = new TokenBucket(2, 1, 0)
    bucket.tryConsume(2, 0)
    expect(bucket.tryConsume(1, 0)).toBe(false)
  })

  it('refills over time at the configured rate', () => {
    const bucket = new TokenBucket(10, 5, 0)
    bucket.tryConsume(10, 0)
    expect(bucket.tryConsume(1, 0)).toBe(false)
    expect(bucket.tryConsume(1, 1_000)).toBe(true) // 5 tokens returned after 1s
  })

  it('never refills beyond capacity', () => {
    const bucket = new TokenBucket(5, 100, 0)
    expect(bucket.availableTokens(60_000)).toBe(5)
  })

  it('refuses a multi-token request it cannot fully satisfy', () => {
    const bucket = new TokenBucket(5, 1, 0)
    expect(bucket.tryConsume(6, 0)).toBe(false)
    expect(bucket.availableTokens(0)).toBe(5)
  })
})
