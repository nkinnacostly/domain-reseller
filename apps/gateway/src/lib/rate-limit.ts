/**
 * Token bucket per operation class.
 *
 * DomainNameAPI publishes no rate limits (PRD V4), so we throttle conservatively
 * on our side rather than discovering the ceiling in production.
 */
export class TokenBucket {
  private tokens: number
  private lastRefill: number

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    now: number = Date.now(),
  ) {
    this.tokens = capacity
    this.lastRefill = now
  }

  tryConsume(count = 1, now: number = Date.now()): boolean {
    this.refill(now)
    if (this.tokens < count) return false
    this.tokens -= count
    return true
  }

  availableTokens(now: number = Date.now()): number {
    this.refill(now)
    return Math.floor(this.tokens)
  }

  private refill(now: number): void {
    const elapsedSeconds = (now - this.lastRefill) / 1000
    if (elapsedSeconds <= 0) return
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond)
    this.lastRefill = now
  }
}

/**
 * Refill rates follow the measured supplier ceiling (PRD V4): two concurrent
 * calls of ~1s each is ~2 calls a second. Availability admits a burst of 24
 * calls (a handful of searches) and then refuses rather than queueing work
 * nobody will wait for.
 *
 * Bulk search (FR-S5) draws on its own bucket, so a long list can never spend
 * the tokens single searches need. It holds one supplier slot at most, and a
 * call there takes a second or more, so one list checked block by block
 * stays inside the refill; many lists at once are refused, and retried by
 * the person, rather than queued behind each other.
 */
export const buckets = {
  availability: new TokenBucket(24, 2),
  bulkAvailability: new TokenBucket(12, 1),
  read: new TokenBucket(30, 15),
  write: new TokenBucket(5, 2),
} as const
