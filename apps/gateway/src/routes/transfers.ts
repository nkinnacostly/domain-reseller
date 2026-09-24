import { mapSupplierError, transferCheckRequestSchema } from '@dr/shared'
import { Hono } from 'hono'
import { getDnaWriteClient, type WriteTarget } from '../dna/client'
import { env } from '../env'
import { logger } from '../lib/logger'
import { TokenBucket } from '../lib/rate-limit'
import { createDnaRegistrar, type TransferRegistrar } from '../provisioning/registrar'

/**
 * POST /v1/transfers/check — can this domain come to us with this code?
 * (PRD FR-T1, N4: asked before any money is taken.)
 *
 * Asked on the side the order will be worked on — a test order in the
 * sandbox, a live one at the live registry — so the answer is about the
 * account that will send the Transfer. A gateway not writing to that side
 * refuses rather than answering for the wrong one.
 *
 * The code goes to the supplier and nowhere else: not to a log line, and not
 * back in the answer (N13). Only the extension and the verdict are logged.
 */

type Deps = {
  /** The side this gateway writes to (DNA_WRITE_ENV); null with writes off. */
  target: WriteTarget | null
  registrar: (target: WriteTarget) => Pick<TransferRegistrar, 'checkTransfer'>
  bucket: TokenBucket
}

/**
 * A check can confirm a guessed code, so it is metered here as well as per
 * account in the web app: a burst of ten, then one every ten seconds.
 */
const checks = new TokenBucket(10, 0.1)

function defaultRegistrar(target: WriteTarget) {
  return createDnaRegistrar({
    client: getDnaWriteClient(target),
    environment: target,
    // Not provisioning, so not recorded in supplier_calls; the outcome is logged below.
    audit: async () => {},
    // Someone is waiting at checkout: go ahead of queued work, and give up in time.
    slotWait: { waitMs: 10_000, priority: 'high' },
  })
}

export function createTransfersRoute(overrides: Partial<Deps> = {}) {
  const deps: Deps = {
    target: env.DNA_WRITE_ENV === 'off' ? null : env.DNA_WRITE_ENV,
    registrar: defaultRegistrar,
    bucket: checks,
    ...overrides,
  }

  return new Hono().post('/check', async (c) => {
    const parsed = transferCheckRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json(
        { ok: false, code: 'VALIDATION_FAILED', message: 'Invalid transfer check' },
        400,
      )
    }
    const { domainName, authCode, testMode } = parsed.data
    const side: WriteTarget = testMode ? 'ote' : 'production'
    if (deps.target !== side) {
      logger.warn({ side, target: deps.target }, 'transfer check refused: not this side')
      return c.json(
        {
          ok: false,
          code: 'TRANSFERS_UNAVAILABLE',
          message: `This gateway does not work ${testMode ? 'test' : 'live'} transfers`,
          retryable: false,
        },
        409,
      )
    }
    if (!deps.bucket.tryConsume()) {
      return c.json(
        {
          ok: false,
          code: 'RATE_LIMITED',
          message: 'Too many transfer checks at once.',
          retryable: true,
        },
        429,
      )
    }

    const tld = domainName.slice(domainName.indexOf('.') + 1)
    const started = Date.now()
    const answer = await deps.registrar(side).checkTransfer(domainName, authCode)
    if (answer.kind === 'ok') {
      logger.info(
        {
          tld,
          transferable: answer.data.transferable,
          reason: answer.data.transferable ? undefined : answer.data.reason,
          ms: Date.now() - started,
        },
        'transfer check',
      )
      return c.json({ ok: true, data: answer.data })
    }
    logger.warn({ tld, code: answer.code, ms: Date.now() - started }, 'transfer check failed')
    const error = mapSupplierError(answer.kind === 'blocked' ? 'CREDENTIALS' : 'TIMEOUT')
    return c.json(
      { ok: false, code: error.code, message: error.message, retryable: error.retryable },
      502,
    )
  })
}
