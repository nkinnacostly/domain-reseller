/**
 * Caps how many supplier calls are in flight, first come first served.
 *
 * DomainNameAPI answers `API_429` to a third concurrent request (measured
 * 22 Sept 2026: two in flight always succeed, a third is refused within
 * ~0.5s; back-to-back sequential calls are never refused). One process-wide
 * limit keeps every route inside that ceiling.
 */
export class QueueTimeout extends Error {
  constructor() {
    super('Timed out waiting for a supplier slot')
    this.name = 'QueueTimeout'
  }
}

export type Priority = 'high' | 'normal'

type Waiter = { grant: () => void; timer: NodeJS.Timeout | undefined; priority: Priority }

export class Semaphore {
  private active = 0
  private readonly waiting: Waiter[] = []

  constructor(private readonly max: number) {}

  get inFlight(): number {
    return this.active
  }

  get queued(): number {
    return this.waiting.length
  }

  /**
   * Runs `task` once a slot is free, or throws QueueTimeout after `waitMs`.
   * `high` waits ahead of every `normal` task (FIFO within each lane), for the
   * one answer a person is actually watching for.
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
      this.release()
    }
  }

  private acquire(waitMs: number, priority: Priority): Promise<void> {
    if (this.active < this.max) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const entry: Waiter = {
        grant: () => {
          clearTimeout(entry.timer)
          this.active += 1
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
      if (priority === 'high') {
        const firstNormal = this.waiting.findIndex((waiter) => waiter.priority === 'normal')
        this.waiting.splice(firstNormal === -1 ? this.waiting.length : firstNormal, 0, entry)
      } else {
        this.waiting.push(entry)
      }
    })
  }

  private release(): void {
    this.active -= 1
    this.waiting.shift()?.grant()
  }
}

/** The one limit every supplier call shares. */
export const supplierSlots = new Semaphore(2)
