import { readCsr, sslHostnameSchema } from '@dr/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import type { WriteTarget } from '../dna/client'
import { env } from '../env'
import { logger } from '../lib/logger'
import { TokenBucket } from '../lib/rate-limit'
import { createSslClient, type SslClient } from '../ssl/client'

/**
 * The SSL set-up's helpers, for the web app (FR-SSL-4). Reads, none of
 * which buys anything:
 *
 *   GET  /v1/ssl/approvers?name=&product=  — the addresses the CA can email
 *   POST /v1/ssl/csr/check                 — what a CSR asks for
 *   POST /v1/ssl/csr/generate              — a new key and request, made by
 *                                            the supplier for the customer
 *
 * The generated private key is the customer's: it is in this answer and
 * nowhere else — not a log line, not a table, not a cache (N13). The web
 * hands it to the browser once and keeps none of it.
 */

type Deps = {
  /** The side this gateway writes to; null with writes off. */
  target: WriteTarget | null
  client: (target: WriteTarget) => SslClient
  /** Generating keys is metered harder than reading. */
  reads: TokenBucket
  generates: TokenBucket
}

const NAME = z
  .string()
  .max(260)
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.string().regex(/^(\*\.)?[a-z0-9.-]+$/))

function defaultClient(target: WriteTarget): SslClient {
  return createSslClient({
    environment: target,
    apiKey: (target === 'ote' ? env.DNA_API_TEST_KEY : env.DNA_API_KEY) ?? '',
    resellerId: env.DNA_RESELLER_ID,
    // Not a job: nothing to record against; outcomes are logged below.
    audit: async () => {},
    // Someone is waiting on the set-up page.
    slotWait: { waitMs: 15_000, priority: 'normal' },
    timeoutMs: 30_000,
  })
}

const generateSchema = z.object({
  name: z.string().max(260),
  alternativeNames: z.array(z.string().max(253)).max(250).default([]),
  country: z.string().regex(/^[A-Z]{2}$/),
  state: z.string().min(1).max(50),
  locality: z.string().min(1).max(50),
  organization: z.string().min(1).max(150),
  organizationUnit: z.string().min(1).max(150),
})

export function createSslRoute(overrides: Partial<Deps> = {}) {
  const deps: Deps = {
    target: env.DNA_WRITE_ENV === 'off' ? null : env.DNA_WRITE_ENV,
    client: defaultClient,
    reads: new TokenBucket(30, 1),
    generates: new TokenBucket(10, 0.1),
    ...overrides,
  }

  const refuse = (code: string, message: string, retryable = false) => ({
    ok: false as const,
    code,
    message,
    retryable,
  })
  const off = refuse('SSL_OFF', 'This gateway does not reach the supplier')
  const busy = refuse('RATE_LIMITED', 'Too many requests. Try again shortly.', true)
  const down = refuse('SUPPLIER_UNAVAILABLE', 'The supplier could not be asked just now', true)

  return (
    new Hono()
      // Nothing here is ever kept by a cache on the way — a key least of all (N13).
      .use('*', async (c, next) => {
        await next()
        c.header('Cache-Control', 'no-store')
        c.header('Pragma', 'no-cache')
      })
      .get('/approvers', async (c) => {
        const name = NAME.safeParse(c.req.query('name') ?? '')
        const product = c.req.query('product') ?? ''
        const bare = name.success ? name.data.replace(/^\*\./, '') : ''
        if (
          !name.success ||
          !sslHostnameSchema.safeParse(bare).success ||
          !/^[A-Za-z0-9]{1,16}$/.test(product)
        ) {
          return c.json(
            refuse('VALIDATION_FAILED', 'A certificate name and product are required'),
            400,
          )
        }
        if (!deps.target) return c.json(off, 409)
        if (!deps.reads.tryConsume()) return c.json(busy, 429)
        const read = await deps.client(deps.target).approvers(name.data, product)
        logger.info({ outcome: read.kind }, 'SSL approvers read')
        if (read.kind === 'found') return c.json({ ok: true, data: { emails: read.data } })
        return c.json(down, 502)
      })
      .post('/csr/check', async (c) => {
        const body = (await c.req.json().catch(() => null)) as { csr?: unknown } | null
        const csr = readCsr(typeof body?.csr === 'string' ? body.csr : '')
        if (!csr.ok) return c.json(refuse('CSR_INVALID', csr.reason), 422)
        if (!deps.target) return c.json(off, 409)
        if (!deps.reads.tryConsume()) return c.json(busy, 429)
        const read = await deps.client(deps.target).checkCsr(csr.csr)
        logger.info({ outcome: read.kind }, 'SSL CSR checked')
        if (read.kind === 'found') return c.json({ ok: true, data: read.data })
        if (read.kind === 'unknown' && read.code === 'CSR_INVALID') {
          return c.json(
            refuse('CSR_INVALID', 'The certificate authority could not read that request'),
            422,
          )
        }
        return c.json(down, 502)
      })
      .post('/csr/generate', async (c) => {
        const parsed = generateSchema.safeParse(await c.req.json().catch(() => null))
        const name = parsed.success ? NAME.safeParse(parsed.data.name) : null
        if (!parsed.success || !name?.success) {
          return c.json(refuse('VALIDATION_FAILED', 'The request details are incomplete'), 400)
        }
        if (!deps.target) return c.json(off, 409)
        if (!deps.generates.tryConsume()) return c.json(busy, 429)
        const made = await deps.client(deps.target).generateCsr({ ...parsed.data, name: name.data })
        // The outcome only: never the request, and never the key (N13).
        logger.info({ outcome: made.kind }, 'SSL key and CSR generated')
        if (made.kind === 'found') return c.json({ ok: true, data: made.data })
        return c.json(down, 502)
      })
  )
}
