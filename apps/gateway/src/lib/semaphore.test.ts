import { describe, expect, it } from 'vitest'
import { QueueTimeout, Semaphore } from './semaphore'

const deferred = () => {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('Semaphore', () => {
  it('queues a third task and runs it in the first slot that frees', async () => {
    const slots = new Semaphore(2)
    const slowGate = deferred()
    const order: string[] = []

    const slow = slots.run(async () => {
      await slowGate.promise
      order.push('slow')
    })
    const quick = slots.run(async () => {
      order.push('quick')
    })
    const third = slots.run(async () => {
      order.push('third')
    })

    expect(slots.inFlight).toBe(2)
    expect(slots.queued).toBe(1)

    await Promise.all([quick, third])
    slowGate.resolve()
    await slow

    expect(order).toEqual(['quick', 'third', 'slow'])
    expect(slots.inFlight).toBe(0)
  })

  it('frees the slot even when the task throws', async () => {
    const slots = new Semaphore(1)
    await expect(slots.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(slots.inFlight).toBe(0)
    await expect(slots.run(async () => 'ok')).resolves.toBe('ok')
  })

  it('gives up waiting after the deadline, and leaves the queue clean', async () => {
    const slots = new Semaphore(1)
    const gate = deferred()
    const holder = slots.run(() => gate.promise)

    await expect(slots.run(async () => 'late', { waitMs: 10 })).rejects.toBeInstanceOf(QueueTimeout)
    expect(slots.queued).toBe(0)

    gate.resolve()
    await holder
    expect(slots.inFlight).toBe(0)
  })
})

describe('Semaphore priority', () => {
  it('lets a high-priority task overtake every normal one waiting', async () => {
    const slots = new Semaphore(1)
    const gate = deferred()
    const order: string[] = []
    const holder = slots.run(() => gate.promise)

    const normalA = slots.run(async () => {
      order.push('normal-a')
    })
    const normalB = slots.run(async () => {
      order.push('normal-b')
    })
    const highA = slots.run(
      async () => {
        order.push('high-a')
      },
      { priority: 'high' },
    )
    const highB = slots.run(
      async () => {
        order.push('high-b')
      },
      { priority: 'high' },
    )

    gate.resolve()
    await Promise.all([holder, normalA, normalB, highA, highB])
    expect(order).toEqual(['high-a', 'high-b', 'normal-a', 'normal-b'])
  })
})

describe('Semaphore low lane (FR-S5 bulk search)', () => {
  it('never lets low tasks hold more than their share, so a normal task starts at once', async () => {
    const slots = new Semaphore(2, 1)
    const gate = deferred()
    const order: string[] = []

    const bulkA = slots.run(
      async () => {
        await gate.promise
        order.push('bulk-a')
      },
      { priority: 'low' },
    )
    const bulkB = slots.run(
      async () => {
        order.push('bulk-b')
      },
      { priority: 'low' },
    )
    // One slot is still free, but only for work that is not bulk.
    expect(slots.inFlight).toBe(1)
    expect(slots.queued).toBe(1)

    await slots.run(async () => {
      order.push('normal')
    })
    expect(order).toEqual(['normal'])

    gate.resolve()
    await Promise.all([bulkA, bulkB])
    expect(order).toEqual(['normal', 'bulk-a', 'bulk-b'])
    expect(slots.inFlight).toBe(0)
  })

  it('serves every high and normal waiter before a low one', async () => {
    const slots = new Semaphore(1)
    const gate = deferred()
    const order: string[] = []
    const holder = slots.run(() => gate.promise)

    const task = (name: string, priority: 'high' | 'normal' | 'low') =>
      slots.run(
        async () => {
          order.push(name)
        },
        { priority },
      )
    const queued = [
      task('low-a', 'low'),
      task('normal-a', 'normal'),
      task('low-b', 'low'),
      task('high-a', 'high'),
      task('normal-b', 'normal'),
    ]

    gate.resolve()
    await Promise.all([holder, ...queued])
    expect(order).toEqual(['high-a', 'normal-a', 'normal-b', 'low-a', 'low-b'])
  })

  it('lets a low waiter give up without blocking the lane behind it', async () => {
    const slots = new Semaphore(2, 1)
    const gate = deferred()
    const holder = slots.run(() => gate.promise, { priority: 'low' })

    await expect(
      slots.run(async () => 'late', { priority: 'low', waitMs: 10 }),
    ).rejects.toBeInstanceOf(QueueTimeout)
    expect(slots.queued).toBe(0)

    gate.resolve()
    await holder
    await expect(slots.run(async () => 'next', { priority: 'low' })).resolves.toBe('next')
  })

  it('without a cap, low tasks may use every slot when nothing else wants one', async () => {
    const slots = new Semaphore(2)
    const gate = deferred()
    const a = slots.run(() => gate.promise, { priority: 'low' })
    const b = slots.run(() => gate.promise, { priority: 'low' })
    expect(slots.inFlight).toBe(2)
    gate.resolve()
    await Promise.all([a, b])
  })
})
