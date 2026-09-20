import { describe, expect, it, vi } from 'vitest'
import { MemoryIdempotencyStore, runIdempotentWrite, type WriteOutcome } from './idempotency'

const notFound: WriteOutcome<{ id: string }> = {
  kind: 'failed',
  code: 'DOMAIN_NOT_FOUND',
  message: 'not registered',
  retryable: false,
}

describe('runIdempotentWrite', () => {
  it('performs the write when nothing exists yet', async () => {
    const store = new MemoryIdempotencyStore()
    const write = vi.fn(async () => ({ kind: 'succeeded', data: { id: 'a' } }) as const)
    const verify = vi.fn(async () => notFound)

    const result = await runIdempotentWrite({ store, key: 'k1', write, verify })

    expect(result).toEqual({ kind: 'succeeded', data: { id: 'a' } })
    expect(write).toHaveBeenCalledOnce()
  })

  it('skips the write when a pre-flight check shows it already happened', async () => {
    const store = new MemoryIdempotencyStore()
    const write = vi.fn<() => Promise<WriteOutcome<{ id: string }>>>(async () => ({
      kind: 'succeeded',
      data: { id: 'b' },
    }))
    const verify = vi.fn<() => Promise<WriteOutcome<{ id: string }>>>(async () => ({
      kind: 'succeeded',
      data: { id: 'existing' },
    }))

    const result = await runIdempotentWrite({ store, key: 'k2', write, verify })

    expect(write).not.toHaveBeenCalled()
    expect(result).toEqual({ kind: 'succeeded', data: { id: 'existing' } })
  })

  it('NEVER retries a write after a timeout — it verifies instead (invariant I2)', async () => {
    const store = new MemoryIdempotencyStore()
    const write = vi.fn(async () => ({ kind: 'unknown', reason: 'socket timeout' }) as const)
    const verify = vi
      .fn<() => Promise<WriteOutcome<{ id: string }>>>()
      .mockResolvedValueOnce(notFound)
      .mockResolvedValueOnce({ kind: 'succeeded', data: { id: 'landed-anyway' } })

    const result = await runIdempotentWrite({ store, key: 'k3', write, verify })

    expect(write).toHaveBeenCalledOnce()
    expect(verify).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ kind: 'succeeded', data: { id: 'landed-anyway' } })
  })

  it('reports unknown when verification still cannot confirm the write', async () => {
    const store = new MemoryIdempotencyStore()
    const write = vi.fn(async () => ({ kind: 'unknown', reason: 'gateway timeout' }) as const)
    const verify = vi.fn(async () => notFound)

    const result = await runIdempotentWrite({ store, key: 'k4', write, verify })

    expect(result.kind).toBe('unknown')
  })

  it('replays the stored result for a duplicate key instead of writing again', async () => {
    const store = new MemoryIdempotencyStore()
    const write = vi.fn(async () => ({ kind: 'succeeded', data: { id: 'once' } }) as const)
    const verify = vi.fn(async () => notFound)

    await runIdempotentWrite({ store, key: 'dup', write, verify })
    const second = await runIdempotentWrite({ store, key: 'dup', write, verify })

    expect(write).toHaveBeenCalledOnce()
    expect(second).toEqual({ kind: 'succeeded', data: { id: 'once' } })
  })

  it('refuses a concurrent attempt with the same key', async () => {
    const store = new MemoryIdempotencyStore()
    await store.begin('busy')

    const result = await runIdempotentWrite({
      store,
      key: 'busy',
      write: async () => ({ kind: 'succeeded', data: { id: 'x' } }),
      verify: async () => notFound,
    })

    expect(result.kind).toBe('unknown')
  })

  it('does not retry a business failure', async () => {
    const store = new MemoryIdempotencyStore()
    const write = vi.fn(async () => notFound)
    const verify = vi.fn(async () => notFound)

    const result = await runIdempotentWrite({ store, key: 'k5', write, verify })

    expect(result.kind).toBe('failed')
    expect(write).toHaveBeenCalledOnce()
  })
})
