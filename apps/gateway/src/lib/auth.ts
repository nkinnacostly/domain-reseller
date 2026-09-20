import { timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { env } from '../env'

/** Shared-secret auth. The gateway is internal — it is never exposed publicly. */
export const requireGatewaySecret: MiddlewareHandler = async (c, next) => {
  const header = c.req.header('authorization') ?? ''
  const provided = header.startsWith('Bearer ') ? header.slice(7) : ''

  const a = Buffer.from(provided)
  const b = Buffer.from(env.GATEWAY_SHARED_SECRET)

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return c.json({ ok: false, code: 'SUPPLIER_AUTH', message: 'Unauthorised' }, 401)
  }

  await next()
  return undefined
}
