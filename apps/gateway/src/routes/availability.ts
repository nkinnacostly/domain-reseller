import {
  AVAILABILITY_LIMITS,
  type AvailabilityResult,
  type AvailabilityStatus,
  availabilityRequestSchema,
  type GatewayError,
  mapSupplierError,
} from '@dr/shared'
import { Hono } from 'hono'
import type DomainNameApi from 'nodejs-dna'
import type { DnaAvailability, DnaFail } from 'nodejs-dna'
import { classifyAvailability } from '../dna/availability'
import { getDnaClient } from '../dna/client'
import { logger } from '../lib/logger'
import { buckets, type TokenBucket } from '../lib/rate-limit'
import { type Priority, QueueTimeout, type Semaphore, supplierSlots } from '../lib/semaphore'
import { TtlCache } from '../lib/ttl-cache'

/**
 * POST /v1/availability — names × extensions (PRD FR-S1, FR-S6).
 *
 * Measured against production (PRD V4): a call costs ~0.75s per extension and
 * almost nothing per extra name, the supplier refuses a third concurrent call
 * with API_429, and a call of more than 20 name × extension checks with HTTP
 * 403 (24 Sept 2026). So a request's extensions are split into at most as many
 * groups as there are supplier slots, each group's names into calls of at most
 * 20 checks, and every call waits its turn for a slot. A refused call is retried — availability is a read, so a retry cannot
 * double-spend anything (ADR-004).
 *
 * Bulk search (FR-S5) asks with `priority: 'low'`: it queues behind every
 * other search, holds one of the two slots at most (see supplierSlots), draws
 * on its own rate limit and may wait longer for its turn, because nobody is
 * watching a single row of it.
 *
 * `fresh: true` skips the cache read (FR-S6): a cached answer is re-validated
 * before a name goes into a cart or is paid for.
 *
 * Searches are never logged (FR-S7) — only extensions, counts and timings.
 */

/** FR-S6: 60 seconds per (name, extension), to protect the supplier quota. */
const CACHE_TTL_MS = 60_000
const SUPPLIER_TIMEOUT_MS = 10_000
/** How long a call may wait for a slot before its extensions come back `unknown`. */
const QUEUE_WAIT_MS = 8_000
/**
 * Bulk waits behind everyone, and for the one slot it may use, so it gets
 * longer: its block is one call in a list nobody watches row by row, and the
 * blocks of other people's lists may be queued ahead of it.
 */
const LOW_QUEUE_WAIT_MS = 20_000
const RETRIES_ON_429 = 2

type Deps = {
  client: () => DomainNameApi
  bucket: TokenBucket
  /** Bulk search's own limit, so it never spends what single searches need. */
  bulkBucket: TokenBucket
  cache: TtlCache<AvailabilityStatus>
  slots: Semaphore
  /** Batches per request; matches the supplier's concurrency ceiling. */
  batches: number
  timeoutMs: number
  queueWaitMs: number
  lowQueueWaitMs: number
  /** Backoff before retrying an API_429, in ms. */
  backoff: (attempt: number) => number
}

type BatchOutcome =
  | { ok: true; statuses: Map<string, AvailabilityStatus> }
  | { ok: false; error: GatewayError }

class SupplierTimeout extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SupplierTimeout()), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * The supplier calls a request becomes: extensions dealt into `parts` groups
 * (one per supplier slot, so a search's halves run side by side), then each
 * group's names split so no call asks more than `maxChecks` name × extension
 * questions — the supplier refuses a bigger call with HTTP 403.
 */
export function toCalls(
  names: string[],
  tlds: string[],
  parts: number,
  maxChecks: number = AVAILABILITY_LIMITS.maxChecksPerCall,
): { names: string[]; tlds: string[] }[] {
  const calls: { names: string[]; tlds: string[] }[] = []
  for (const group of toBatches(tlds, parts)) {
    for (let t = 0; t < group.length; t += maxChecks) {
      const groupTlds = group.slice(t, t + maxChecks)
      const perCall = Math.max(1, Math.floor(maxChecks / groupTlds.length))
      for (let n = 0; n < names.length; n += perCall) {
        calls.push({ names: names.slice(n, n + perCall), tlds: groupTlds })
      }
    }
  }
  return calls
}

/** Deals extensions round-robin into `parts` batches, keeping the first one first. */
export function toBatches<T>(items: T[], parts: number): T[][] {
  const batches: T[][] = Array.from({ length: Math.min(parts, items.length) }, () => [])
  items.forEach((item, index) => {
    batches[index % batches.length]?.push(item)
  })
  return batches
}

async function callSupplier(
  deps: Deps,
  names: string[],
  tlds: string[],
): Promise<DnaAvailability[] | DnaFail> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await withTimeout(
      deps.client().CheckAvailability(names, tlds, 1),
      deps.timeoutMs,
    )
    const rateLimited = !Array.isArray(response) && response.error.Code === 'API_429'
    if (!rateLimited || attempt >= RETRIES_ON_429) return response
    await sleep(deps.backoff(attempt))
  }
}

async function checkBatch(
  deps: Deps,
  names: string[],
  tlds: string[],
  priority: Priority,
): Promise<BatchOutcome> {
  const started = Date.now()
  let waitedMs = 0
  try {
    const response = await deps.slots.run(
      () => {
        waitedMs = Date.now() - started
        return callSupplier(deps, names, tlds)
      },
      { waitMs: priority === 'low' ? deps.lowQueueWaitMs : deps.queueWaitMs, priority },
    )

    if (!Array.isArray(response)) {
      logger.warn(
        { tlds, code: response.error.Code, waitedMs, ms: Date.now() - started - waitedMs },
        'supplier availability failed',
      )
      return { ok: false, error: mapSupplierError(response.error.Code) }
    }

    const wanted = new Set(tlds)
    const statuses = new Map<string, AvailabilityStatus>()
    for (const row of response) {
      const tld = row.TLD.toLowerCase()
      if (!wanted.has(tld)) continue
      statuses.set(`${row.DomainName.toLowerCase()}.${tld}`, classifyAvailability(row))
    }
    logger.info(
      { tlds, names: names.length, priority, waitedMs, ms: Date.now() - started - waitedMs },
      'supplier availability',
    )
    return { ok: true, statuses }
  } catch (err) {
    logger.warn(
      {
        tlds,
        reason:
          err instanceof QueueTimeout
            ? 'queue'
            : err instanceof SupplierTimeout
              ? 'timeout'
              : 'error',
        ms: Date.now() - started,
      },
      'supplier availability failed',
    )
    return { ok: false, error: mapSupplierError('TIMEOUT') }
  }
}

export function createAvailabilityRoute(overrides: Partial<Deps> = {}) {
  const deps: Deps = {
    client: getDnaClient,
    bucket: buckets.availability,
    bulkBucket: buckets.bulkAvailability,
    cache: new TtlCache<AvailabilityStatus>(CACHE_TTL_MS, 20_000),
    slots: supplierSlots,
    batches: 2,
    timeoutMs: SUPPLIER_TIMEOUT_MS,
    queueWaitMs: QUEUE_WAIT_MS,
    lowQueueWaitMs: LOW_QUEUE_WAIT_MS,
    backoff: (attempt) => 300 * 2 ** attempt + Math.random() * 200,
    ...overrides,
  }

  return new Hono().post('/', async (c) => {
    const parsed = availabilityRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json(
        { ok: false, code: 'VALIDATION_FAILED', message: 'Invalid availability request' },
        400,
      )
    }

    const { priority, fresh } = parsed.data
    const names = [...new Set(parsed.data.names)]
    const tlds = [...new Set(parsed.data.tlds)]
    const key = (name: string, tld: string) => `${name}.${tld}`
    const cached = (name: string, tld: string) =>
      !fresh && deps.cache.get(key(name, tld)) !== undefined

    // Only what the cache cannot answer goes to the supplier.
    const uncachedTlds = tlds.filter((tld) => names.some((name) => !cached(name, tld)))
    const uncachedNames = names.filter((name) => uncachedTlds.some((tld) => !cached(name, tld)))
    const calls = uncachedNames.length > 0 ? toCalls(uncachedNames, uncachedTlds, deps.batches) : []

    const bucket = priority === 'low' ? deps.bulkBucket : deps.bucket
    if (calls.length > 0 && !bucket.tryConsume(calls.length)) {
      return c.json(
        {
          ok: false,
          code: 'RATE_LIMITED',
          message: 'Too many searches at once. Try again in a moment.',
          retryable: true,
        },
        429,
      )
    }

    const outcomes = await Promise.all(
      calls.map((call) => checkBatch(deps, call.names, call.tlds, priority)),
    )

    const answered = new Map<string, AvailabilityStatus>()
    for (const outcome of outcomes) {
      if (!outcome.ok) continue
      // Premium and restricted answers are as stable as available ones;
      // `unknown` is never cached, so the next search asks again.
      for (const [domain, status] of outcome.statuses) {
        answered.set(domain, status)
        deps.cache.set(domain, status)
      }
    }

    // A fresh request never falls back to the cache: an answer it could not
    // get again is `unknown`, not the old one (FR-S6).
    const statusOf = (domain: string) =>
      answered.get(domain) ?? (fresh ? undefined : deps.cache.get(domain)) ?? 'unknown'
    const results: AvailabilityResult[] = names.flatMap((name) =>
      tlds.map((tld) => ({ name, tld, domain: key(name, tld), status: statusOf(key(name, tld)) })),
    )

    // Every call failed and nothing came from cache: that is an outage, not a
    // page of unknowns, and the caller should say so.
    const firstFailure = outcomes.find((outcome) => !outcome.ok)
    if (
      firstFailure &&
      !firstFailure.ok &&
      outcomes.every((outcome) => !outcome.ok) &&
      results.every((result) => result.status === 'unknown')
    ) {
      const { error } = firstFailure
      return c.json(
        { ok: false, code: error.code, message: error.message, retryable: error.retryable },
        502,
      )
    }

    return c.json({ ok: true, data: { results } })
  })
}
