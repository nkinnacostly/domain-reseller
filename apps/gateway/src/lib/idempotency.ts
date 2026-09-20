/**
 * Idempotency for supplier writes.
 *
 * DomainNameAPI has no idempotency keys (PRD §5.4), so we provide our own.
 * The rule that matters (invariant I2): a network timeout is NEVER a failure.
 * It is *unknown*, and is resolved by reading state — never by retrying blind.
 */
export type IdempotencyRecord = {
  key: string
  status: 'in_flight' | 'succeeded' | 'failed'
  result?: unknown
  startedAt: number
  completedAt?: number
}

export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | null>
  begin(key: string): Promise<'acquired' | 'already_in_flight' | 'already_done'>
  complete(key: string, status: 'succeeded' | 'failed', result?: unknown): Promise<void>
}

/** In-memory implementation for tests and local development. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>()

  async get(key: string): Promise<IdempotencyRecord | null> {
    return this.records.get(key) ?? null
  }

  async begin(key: string): Promise<'acquired' | 'already_in_flight' | 'already_done'> {
    const existing = this.records.get(key)
    if (!existing) {
      this.records.set(key, { key, status: 'in_flight', startedAt: Date.now() })
      return 'acquired'
    }
    return existing.status === 'in_flight' ? 'already_in_flight' : 'already_done'
  }

  async complete(key: string, status: 'succeeded' | 'failed', result?: unknown): Promise<void> {
    const existing = this.records.get(key)
    this.records.set(key, {
      key,
      status,
      result,
      startedAt: existing?.startedAt ?? Date.now(),
      completedAt: Date.now(),
    })
  }
}

export type WriteOutcome<T> =
  | { kind: 'succeeded'; data: T }
  | { kind: 'failed'; code: string; message: string; retryable: boolean }
  | { kind: 'unknown'; reason: string }

/**
 * Run a supplier write exactly once per idempotency key.
 *
 * `verify` is the state-reading escape hatch: when the write outcome is unknown
 * (timeout, 5xx, dropped connection) we ask the supplier what actually happened
 * instead of retrying and risking a double registration (invariant I1).
 */
export async function runIdempotentWrite<T>(options: {
  store: IdempotencyStore
  key: string
  write: () => Promise<WriteOutcome<T>>
  verify: () => Promise<WriteOutcome<T>>
}): Promise<WriteOutcome<T>> {
  const { store, key, write, verify } = options

  const acquisition = await store.begin(key)
  if (acquisition === 'already_done') {
    const record = await store.get(key)
    if (record?.status === 'succeeded') return { kind: 'succeeded', data: record.result as T }
    return {
      kind: 'failed',
      code: 'ALREADY_FAILED',
      message: 'Already attempted',
      retryable: false,
    }
  }
  if (acquisition === 'already_in_flight') {
    return { kind: 'unknown', reason: 'A previous attempt with this key is still running' }
  }

  // Always ask first. If a previous process crashed after the supplier accepted
  // the write, this is what stops us doing it twice.
  const preflight = await verify()
  if (preflight.kind === 'succeeded') {
    await store.complete(key, 'succeeded', preflight.data)
    return preflight
  }

  const outcome = await write()

  if (outcome.kind === 'unknown') {
    const confirmed = await verify()
    if (confirmed.kind === 'succeeded') {
      await store.complete(key, 'succeeded', confirmed.data)
      return confirmed
    }
    return outcome
  }

  await store.complete(
    key,
    outcome.kind === 'succeeded' ? 'succeeded' : 'failed',
    outcome.kind === 'succeeded' ? outcome.data : undefined,
  )
  return outcome
}
