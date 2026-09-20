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

/** Conservative defaults until V4 is answered. Tune with evidence, not optimism. */
export const buckets = {
  availability: new TokenBucket(20, 10),
  read: new TokenBucket(30, 15),
  write: new TokenBucket(5, 2),
} as const
