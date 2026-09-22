import { mapSupplierError } from '@dr/shared'
import { Hono } from 'hono'
import type DomainNameApi from 'nodejs-dna'
import { getDnaClient } from '../dna/client'
import { logger } from '../lib/logger'
import { QueueTimeout, type Semaphore, supplierSlots } from '../lib/semaphore'

/**
 * GET /v1/account/balance — the prepaid float, in USD (FR-C8).
 *
 * Read-only and uncached: it is asked once per checkout, just before money
 * moves, and a stale answer is exactly what the pre-flight exists to avoid.
 */
type Deps = { client: () => DomainNameApi; slots: Semaphore; timeoutMs: number }

export function createAccountRoute(overrides: Partial<Deps> = {}) {
  const deps: Deps = { client: getDnaClient, slots: supplierSlots, timeoutMs: 10_000, ...overrides }

  return new Hono().get('/balance', async (c) => {
    const started = Date.now()
    try {
      const response = await deps.slots.run(() => deps.client().GetCurrentBalance('USD'), {
        waitMs: 8_000,
        priority: 'high',
      })
      const balance = Number(response.Balance)
      if (response.OperationResult !== 'SUCCESS' || !Number.isFinite(balance)) {
        logger.warn(
          { result: response.OperationResult, ms: Date.now() - started },
          'balance read failed',
        )
        const error = mapSupplierError('BALANCE')
        return c.json({ ok: false, code: error.code, message: error.message, retryable: true }, 502)
      }
      logger.info({ ms: Date.now() - started }, 'supplier balance')
      return c.json({ ok: true, data: { balanceUsd: balance } })
    } catch (err) {
      logger.warn(
        { reason: err instanceof QueueTimeout ? 'queue' : 'error', ms: Date.now() - started },
        'balance read failed',
      )
      const error = mapSupplierError('TIMEOUT')
      return c.json({ ok: false, code: error.code, message: error.message, retryable: true }, 502)
    }
  })
}
