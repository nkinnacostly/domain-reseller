/**
 * A small bounded cache with per-entry expiry.
 *
 * In-memory is enough: the gateway is a single process, and losing the cache
 * on restart costs a few supplier calls, not correctness. Map preserves
 * insertion order, so evicting the first key evicts the oldest entry.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>()

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  get(key: string, now: number = Date.now()): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= now) {
      this.entries.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: string, value: V, now: number = Date.now()): void {
    this.entries.delete(key)
    this.entries.set(key, { value, expiresAt: now + this.ttlMs })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }
}
