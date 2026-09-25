/**
 * Caps how many supplier calls are in flight, and how many start each second,
 * first come first served.
 *
 * DomainNameAPI answers `API_429` to a third concurrent request (measured
 * 22 Sept 2026: two in flight always succeed, a third is refused within
 * ~0.5s). Its support confirmed on 25 Sept 2026 that the account-wide hard
 * limit is 2 requests per second, that it cannot be raised, and that going
 * past softer thresholds adds latency. One process-wide limit keeps every
 * route inside both.
 */
export class QueueTimeout extends Error {
  constructor() {
    super('Timed out waiting for a supplier slot')
    this.name = 'QueueTimeout'
  }
}

/**
 * `high` — the one answer a person is watching for (the exact match).
 * `normal` — everything else a person is waiting on.
 * `low` — bulk search (FR-S5): waits behind both, and is capped below the
 * full limit so it can never hold every slot while someone searches.
 */
export type Priority = 'high' | 'normal' | 'low'

const RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 }

type Waiter = { grant: () => void; timer: NodeJS.Timeout | undefined; priority: Priority }

const WINDOW_MS = 1_000

export class Semaphore {
  private active = 0
  private activeLow = 0
  private readonly waiting: Waiter[] = []
  /** When recent tasks started, oldest first — at most `startsPerSecond` of them. */
  private readonly starts: number[] = []
  private wake: NodeJS.Timeout | undefined

  /**
   * @param max    tasks in flight at once
   * @param maxLow of those, how many may be `low` — below `max` keeps a slot
   *               free for people searching one name at a time
   * @param startsPerSecond tasks that may start in any one-second window
   */
  constructor(
    private readonly max: number,
    private readonly maxLow: number = max,
    private readonly startsPerSecond: number = Number.POSITIVE_INFINITY,
  ) {}

  get inFlight(): number {
    return this.active
  }

  get queued(): number {
    return this.waiting.length
  }

  /**
   * Runs `task` once a slot is free, or throws QueueTimeout after `waitMs`.
   * Waiters are served by lane — `high`, then `normal`, then `low` — and
   * first come first served within a lane.
   */
  async run<T>(
    task: () => Promise<T>,
    {
      waitMs = Number.POSITIVE_INFINITY,
      priority = 'normal',
    }: { waitMs?: number; priority?: Priority } = {},
  ): Promise<T> {
    await this.acquire(waitMs, priority)
    try {
      return await task()
    } finally {
      this.release(priority)
    }
  }

  private canStart(priority: Priority): boolean {
    return (
      this.active < this.max &&
      (priority !== 'low' || this.activeLow < this.maxLow) &&
      this.withinRate()
    )
  }

  /** Whether another task may start now without passing `startsPerSecond`. */
  private withinRate(): boolean {
    const cutoff = Date.now() - WINDOW_MS
    while (this.starts.length > 0 && (this.starts[0] as number) <= cutoff) this.starts.shift()
    return this.starts.length < this.startsPerSecond
  }

  private take(priority: Priority): void {
    this.active += 1
    if (priority === 'low') this.activeLow += 1
    if (Number.isFinite(this.startsPerSecond)) this.starts.push(Date.now())
  }

  /** Looks at the queue again once the oldest start leaves the window. */
  private wakeWhenRateAllows(): void {
    if (this.wake || this.waiting.length === 0 || this.withinRate()) return
    const oldest = this.starts[0] as number
    this.wake = setTimeout(
      () => {
        this.wake = undefined
        this.dispatch()
      },
      Math.max(0, oldest + WINDOW_MS - Date.now()),
    )
    this.wake.unref?.()
  }

  private acquire(waitMs: number, priority: Priority): Promise<void> {
    // Nobody eligible is ever left waiting while a slot is free (see
    // `dispatch`), so a task that can start now jumps no one.
    if (this.canStart(priority)) {
      this.take(priority)
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const entry: Waiter = {
        grant: () => {
          clearTimeout(entry.timer)
          this.take(priority)
          resolve()
        },
        timer: undefined,
        priority,
      }
      if (Number.isFinite(waitMs)) {
        entry.timer = setTimeout(() => {
          const index = this.waiting.indexOf(entry)
          if (index !== -1) this.waiting.splice(index, 1)
          reject(new QueueTimeout())
        }, waitMs)
      }
      const behind = this.waiting.findIndex((waiter) => RANK[waiter.priority] > RANK[priority])
      this.waiting.splice(behind === -1 ? this.waiting.length : behind, 0, entry)
      this.wakeWhenRateAllows()
    })
  }

  private release(priority: Priority): void {
    this.active -= 1
    if (priority === 'low') this.activeLow -= 1
    this.dispatch()
  }

  /** Grants free slots to the first waiters allowed to take them. */
  private dispatch(): void {
    while (this.active < this.max) {
      const next = this.waiting.findIndex((waiter) => this.canStart(waiter.priority))
      if (next === -1) break
      const [waiter] = this.waiting.splice(next, 1)
      waiter?.grant()
    }
    this.wakeWhenRateAllows()
  }
}

/**
 * The one limit every supplier call shares: two in flight and two starts a
 * second, the supplier's account-wide limits. Bulk search may hold one of the
 * two slots at most (FR-S5), so single searches are never starved by it.
 */
export const supplierSlots = new Semaphore(2, 1, 2)
