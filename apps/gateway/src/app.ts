import { Hono } from 'hono'
import { routePath } from 'hono/route'
import { createDefaultAdminRouter } from './admin/defaults'
import { requireGatewaySecret } from './lib/auth'
import { logger } from './lib/logger'
import { createAccountRoute } from './routes/account'
import { createAvailabilityRoute } from './routes/availability'
import { createDomainsRoute } from './routes/domains'
import { health } from './routes/health'
import { createSslRoute } from './routes/ssl'
import { createTransfersRoute } from './routes/transfers'

/**
 * The gateway's routes, separate from `serve()` so tests can exercise the
 * real app — auth included — without opening a port.
 */
export function createApp(
  routes: {
    availability?: Hono
    account?: Hono
    domains?: Hono
    transfers?: Hono
    ssl?: Hono
    admin?: Hono
  } = {},
) {
  const app = new Hono()

  app.route('/health', health)

  const v1 = new Hono()
  v1.use('*', requireGatewaySecret)
  v1.route('/availability', routes.availability ?? createAvailabilityRoute())
  v1.route('/account', routes.account ?? createAccountRoute())
  v1.route('/domains', routes.domains ?? createDomainsRoute())
  v1.route('/transfers', routes.transfers ?? createTransfersRoute())
  // FR-SSL-4: the set-up's reads — approvers, CSR check, a generated key and CSR.
  v1.route('/ssl', routes.ssl ?? createSslRoute())
  // ADMIN-SPEC §4: the dashboard's live reads, behind a second secret and an audited note.
  v1.route('/admin', routes.admin ?? (createDefaultAdminRouter() as unknown as Hono))
  app.route('/v1', v1)

  app.notFound((c) => c.json({ ok: false, code: 'NOT_FOUND', message: 'Unknown route' }, 404))

  app.onError((error, c) => {
    // The matched template (`/v1/admin/supplier/domains/:name`), never the
    // filled path: no domain name reaches a log on any route (N13).
    logger.error({ err: error, route: routePath(c) }, 'unhandled gateway error')
    return c.json(
      { ok: false, code: 'SUPPLIER_UNAVAILABLE', message: 'Gateway error', retryable: true },
      500,
    )
  })

  return app
}
