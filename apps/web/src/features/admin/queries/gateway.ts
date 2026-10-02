import 'server-only'

import { ADMIN_GATEWAY_ROUTES, type AdminGatewayRouteName, fillRoute } from '@dr/shared/admin'
import type { AdminPrincipal } from '@/features/admin/queries/session'
import { requireAdminGatewayEnv } from '@/lib/env'
import { callGateway } from '@/lib/gateway'

/**
 * A call to the gateway's `/v1/admin/*` routes (docs/ADMIN-SPEC.md §4.1,
 * §5.1). Every call carries the admin secret, the audit note the action
 * wrote first and the admin's label: the gateway claims that note in SQL
 * before it calls anyone (D22). Logs name the route template, never the
 * filled path, so no domain reaches a log line (N13).
 */

/** The templates the gateway serves, e.g. `admin/supplier/domains/:name`. */
export type AdminGatewayTemplate = (typeof ADMIN_GATEWAY_ROUTES)[AdminGatewayRouteName]['template']

const BY_TEMPLATE = new Map<string, (typeof ADMIN_GATEWAY_ROUTES)[AdminGatewayRouteName]>(
  Object.values(ADMIN_GATEWAY_ROUTES).map((route) => [route.template, route]),
)

export type AdminGatewayCall = {
  admin: AdminPrincipal
  /** The id of the intent note `admin_note` returned for this call. */
  auditId: number
  route: AdminGatewayTemplate
  params?: Readonly<Record<string, string>>
  /** Query parameters — the side, a page, a filter. Never logged. */
  query?: Readonly<Record<string, string | number | undefined>>
  method?: 'GET' | 'POST'
  body?: unknown
}

export async function callAdminGateway<T>({
  admin,
  auditId,
  route,
  params,
  query,
  method,
  body,
}: AdminGatewayCall): Promise<T> {
  const known = BY_TEMPLATE.get(route)
  if (!known) throw new Error('not an admin gateway route')
  const { adminSecret } = requireAdminGatewayEnv()

  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  const filled = fillRoute(route, params)
  const path = search.size > 0 ? `${filled}?${search}` : filled

  return callGateway<T>({
    path,
    method: method ?? known.method,
    body,
    logPath: route,
    headers: {
      'x-admin-secret': adminSecret,
      'x-admin-audit-id': String(auditId),
      'x-admin-label': admin.label,
    },
  })
}
