import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { env } from './env'
import { requireGatewaySecret } from './lib/auth'
import { logger } from './lib/logger'
import { health } from './routes/health'

/**
 * Registrar gateway — PRD §6.4 (ADR-004).
 *
 * The ONLY process that holds DomainNameAPI credentials and the only one that
 * makes outbound calls to them. Deploy on infrastructure with a STATIC EGRESS IP;
 * the supplier allowlists it (error API_301).
 *
 * Responsibilities: credential custody · rate limiting · retry with backoff ·
 * idempotency · circuit breaking · audit logging of every supplier call.
 */
const app = new Hono()

app.route('/health', health)

const v1 = new Hono()
v1.use('*', requireGatewaySecret)
// Routes are mounted here as each epic lands:
//   v1.route('/availability', availability)
//   v1.route('/domains', domains)
//   v1.route('/transfers', transfers)
//   v1.route('/account', account)
app.route('/v1', v1)

app.notFound((c) => c.json({ ok: false, code: 'NOT_FOUND', message: 'Unknown route' }, 404))

app.onError((error, c) => {
  logger.error({ err: error, path: c.req.path }, 'unhandled gateway error')
  return c.json(
    { ok: false, code: 'SUPPLIER_UNAVAILABLE', message: 'Gateway error', retryable: true },
    500,
  )
})

serve({ fetch: app.fetch, port: env.PORT }, ({ port }) => {
  logger.info({ port, dnaEnv: env.DNA_ENV }, 'registrar gateway listening')
})

export { app }
