import { Hono } from 'hono'
import { requireGatewaySecret } from './lib/auth'
import { logger } from './lib/logger'
import { createAccountRoute } from './routes/account'
import { createAvailabilityRoute } from './routes/availability'
import { health } from './routes/health'
import { createTransfersRoute } from './routes/transfers'

/**
 * The gateway's routes, separate from `serve()` so tests can exercise the
 * real app — auth included — without opening a port.
 */
export function createApp(routes: { availability?: Hono; account?: Hono; transfers?: Hono } = {}) {
  const app = new Hono()

  app.route('/health', health)

  const v1 = new Hono()
  v1.use('*', requireGatewaySecret)
  v1.route('/availability', routes.availability ?? createAvailabilityRoute())
  v1.route('/account', routes.account ?? createAccountRoute())
  v1.route('/transfers', routes.transfers ?? createTransfersRoute())
  // Mounted as each epic lands: /domains
  app.route('/v1', v1)

  app.notFound((c) => c.json({ ok: false, code: 'NOT_FOUND', message: 'Unknown route' }, 404))

  app.onError((error, c) => {
    logger.error({ err: error, path: c.req.path }, 'unhandled gateway error')
    return c.json(
      { ok: false, code: 'SUPPLIER_UNAVAILABLE', message: 'Gateway error', retryable: true },
      500,
    )
  })

  return app
}
