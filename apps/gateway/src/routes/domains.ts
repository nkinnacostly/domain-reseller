import { domainNameSchema } from '@dr/shared'
import { Hono } from 'hono'
import { getDnaWriteClient, type WriteTarget } from '../dna/client'
import { env } from '../env'
import { createServiceClient } from '../lib/db'
import { logger } from '../lib/logger'
import { TokenBucket } from '../lib/rate-limit'
import { type AuthCodeReader, createDnaRegistrar } from '../provisioning/registrar'
import { createSupabaseStore, type JobStore } from '../provisioning/store'

/**
 * GET /v1/domains/:name/auth-code?side=sandbox|live — the transfer code
 * (FR-DS5, FR-T5), read from the registry each time it is asked for.
 *
 * The code is the key to someone's domain, so: it comes from the registry
 * on the domain's own side — a sandbox domain from the registrar's test
 * system, a live one from production — and a gateway on the other side, or
 * on none, refuses rather than asking the wrong registry. It is never
 * stored, cached or logged (SEC-12, N13); the answer carries it and nothing
 * else. The web app checks ownership and two-factor (SEC-2) before asking.
 *
 * The shared secret alone is not enough (security audit, 8 Oct 2026): each
 * read needs `X-Intent-Id`, a one-use intent the domain's owner made in SQL
 * at aal2 under a minute ago, claimed here before anything else is spent
 * (migration 65). Without it nothing is read.
 */

type Deps = {
  /** The registry this gateway writes to — the only one it reads codes from. */
  target: 'off' | WriteTarget
  reader: (target: WriteTarget) => AuthCodeReader
  /** Across all domains: a burst for a handful of people, then one every 30 s. */
  all: TokenBucket
  /** Per domain: nobody needs a code more than a few times an hour. */
  perDomain: () => TokenBucket
  /** Claims the owner's one-use intent for this name and side (migration 65); throws if SQL cannot be asked. */
  claimIntent: (intentId: string, name: string, side: 'sandbox' | 'live') => Promise<boolean>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function claimIntentInSql(intentId: string, name: string, side: 'sandbox' | 'live') {
  const { data, error } = await createServiceClient().rpc('claim_auth_code_intent', {
    p_intent_id: intentId,
    p_domain_name: name,
    p_side: side,
  })
  if (error) throw new Error(`claim_auth_code_intent failed: ${error.code ?? 'unknown'}`)
  return data === true
}

const SIDES = { sandbox: 'ote', live: 'production' } as const satisfies Record<string, WriteTarget>

let auditStore: JobStore | null = null

/** The registrar a code is read through, its call recorded like any other (I7). */
function defaultReader(target: WriteTarget): AuthCodeReader {
  auditStore ??= createSupabaseStore()
  const store = auditStore
  return createDnaRegistrar({
    client: getDnaWriteClient(target),
    environment: target,
    audit: (call) => store.recordCall(null, target, call),
  })
}

export function createDomainsRoute(overrides: Partial<Deps> = {}) {
  const deps: Deps = {
    target: env.DNA_WRITE_ENV,
    reader: defaultReader,
    all: new TokenBucket(20, 1 / 30),
    perDomain: () => new TokenBucket(3, 3 / 3600),
    claimIntent: claimIntentInSql,
    ...overrides,
  }
  const buckets = new Map<string, TokenBucket>()

  const refuse = (code: string, message: string, retryable = false) => ({
    ok: false as const,
    code,
    message,
    retryable,
  })

  return (
    new Hono()
      // Nothing on this route is ever kept by a cache on the way (SEC-12).
      .use('*', async (c, next) => {
        await next()
        c.header('Cache-Control', 'no-store')
        c.header('Pragma', 'no-cache')
      })
      .get('/:name/auth-code', async (c) => {
        const started = Date.now()
        const name = domainNameSchema.safeParse(c.req.param('name'))
        const side = c.req.query('side')
        if (!name.success || (side !== 'sandbox' && side !== 'live')) {
          return c.json(refuse('VALIDATION_FAILED', 'A domain name and its side are required'), 400)
        }

        if (deps.target !== SIDES[side]) {
          return c.json(
            refuse(
              'WRONG_REGISTRY',
              side === 'sandbox'
                ? 'This gateway does not reach the registrar’s test system'
                : 'This gateway does not reach the live registry',
            ),
            409,
          )
        }

        // The owner's own, fresh request — or nothing is read, and nothing spent.
        const intent = c.req.header('x-intent-id') ?? ''
        let claimed = false
        if (UUID.test(intent)) {
          try {
            claimed = await deps.claimIntent(intent, name.data, side)
          } catch (error) {
            logger.error(
              { err: error instanceof Error ? error.message : String(error) },
              'transfer code intent not checked',
            )
            return c.json(
              refuse('SUPPLIER_UNAVAILABLE', 'The request could not be checked just now', true),
              503,
            )
          }
        }
        if (!claimed) {
          logger.warn({ side }, 'transfer code refused: no valid intent')
          return c.json(
            refuse('INTENT_REQUIRED', 'This request was not confirmed by the domain’s owner'),
            403,
          )
        }

        let bucket = buckets.get(name.data)
        if (!bucket) {
          if (buckets.size > 5_000) buckets.clear()
          bucket = deps.perDomain()
          buckets.set(name.data, bucket)
        }
        if (!bucket.tryConsume() || !deps.all.tryConsume()) {
          return c.json(
            refuse('RATE_LIMITED', 'Too many transfer code requests. Try again shortly.', true),
            429,
          )
        }

        const read = await deps.reader(deps.target).authCode(name.data)
        // The outcome only: never the name's code, and not the name (N13).
        logger.info({ side, outcome: read.kind, ms: Date.now() - started }, 'transfer code read')

        if (read.kind === 'found') return c.json({ ok: true, data: { authCode: read.data } })
        if (read.kind === 'not_found') {
          return c.json(
            refuse('DOMAIN_NOT_FOUND', 'The registry does not list this domain in our account'),
            404,
          )
        }
        if (read.kind === 'blocked') {
          logger.error({ code: read.code }, 'supplier refused our credentials')
        }
        if (read.code === 'NO_AUTH_CODE') {
          return c.json(
            refuse('AUTH_CODE_UNAVAILABLE', 'The registry gave no transfer code for this domain'),
            502,
          )
        }
        return c.json(
          refuse('SUPPLIER_UNAVAILABLE', 'The registry could not be read just now', true),
          502,
        )
      })
  )
}
