import { serve } from '@hono/node-server'
import { createApp } from './app'
import { env } from './env'
import { logger } from './lib/logger'

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
const app = createApp()

serve({ fetch: app.fetch, port: env.PORT }, ({ port }) => {
  logger.info({ port, dnaEnv: env.DNA_ENV }, 'registrar gateway listening')
})

export { app }
