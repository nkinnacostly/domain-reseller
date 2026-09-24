import 'server-only'

import {
  type AvailabilityPriority,
  type AvailabilityResult,
  availabilityResponseSchema,
  GatewayError,
} from '@dr/shared'
import { cache } from 'react'
import { callGateway } from '@/lib/gateway'
import { logger } from '@/lib/logger'

export type AvailabilityOutcome =
  | { ok: true; results: AvailabilityResult[] }
  | { ok: false; reason: 'rate-limited' | 'unavailable' }

/**
 * The gateway answers from a 60-second cache and asks the supplier otherwise
 * (FR-S6). Past this, a person is better served by "try again" than a spinner.
 */
const TIMEOUT_MS = 15_000

export type AvailabilityOptions = {
  /**
   * Skip the gateway's 60-second cache (FR-S6): for the re-check before a
   * name goes into a cart or is paid for (FR-C7, N4), never for a search.
   */
  fresh?: boolean
  /** Bulk search waits behind every other search, so it may wait longer. */
  timeoutMs?: number
}

/**
 * Availability for names × extensions, via the registrar gateway (N1 — never
 * the supplier directly). Deduplicated per render; not cached across requests
 * here, because the gateway already is.
 */
export function checkAvailability(
  names: readonly string[],
  tlds: readonly string[],
  /**
   * `high` for the exact match — it jumps the gateway's queue (PRD V4);
   * `low` for bulk search, which waits behind everything else (FR-S5).
   */
  priority: AvailabilityPriority = 'normal',
  { fresh = false, timeoutMs = TIMEOUT_MS }: AvailabilityOptions = {},
): Promise<AvailabilityOutcome> {
  // React `cache` compares arguments by identity, so key on a string.
  return checkOnce(JSON.stringify([names, tlds, priority, fresh, timeoutMs]))
}

const checkOnce = cache(async (key: string): Promise<AvailabilityOutcome> => {
  const [names, tlds, priority, fresh, timeoutMs] = JSON.parse(key) as [
    string[],
    string[],
    AvailabilityPriority,
    boolean,
    number,
  ]
  try {
    const data = await callGateway<unknown>({
      path: 'availability',
      body: { names, tlds, priority, ...(fresh ? { fresh } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const parsed = availabilityResponseSchema.safeParse(data)
    if (!parsed.success) {
      logger.error({ issues: parsed.error.issues.length }, 'gateway availability shape changed')
      return { ok: false, reason: 'unavailable' }
    }
    return { ok: true, results: parsed.data.results }
  } catch (err) {
    if (err instanceof GatewayError && err.code === 'RATE_LIMITED') {
      return { ok: false, reason: 'rate-limited' }
    }
    // callGateway has already logged gateway errors; this catches the rest
    // (timeouts, a missing GATEWAY_SHARED_SECRET).
    if (!(err instanceof GatewayError)) logger.error({ err }, 'availability check failed')
    return { ok: false, reason: 'unavailable' }
  }
})
