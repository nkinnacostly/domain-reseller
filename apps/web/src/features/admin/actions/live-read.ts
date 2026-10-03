import 'server-only'

import {
  ADMIN_GATEWAY_ROUTES,
  type AdminGatewayRouteName,
  adminNoteTarget,
  adminRouteSide,
} from '@dr/shared/admin'
import { GatewayError } from '@dr/shared/errors'
import {
  type AdminResult,
  adminAccessError,
  refusedResult,
  toAdminResult,
} from '@/features/admin/lib/errors'
import type { AdminSide } from '@/features/admin/lib/side'
import { adminGatewayConfigured, callAdminGateway } from '@/features/admin/queries/gateway'
import { getAdminSide } from '@/features/admin/queries/session'
import type { AdminContext } from '@/lib/safe-action'

/**
 * Note, then gateway (docs/ADMIN-SPEC.md §4.3, §5.1, D22): every live read
 * and every price-list preview or apply goes through here, after its input
 * is validated. It writes an intent note with `admin_note`, stops if SQL
 * refuses it, then asks the gateway with the note's id — and the gateway
 * claims the note before it calls anyone. A refusal from SQL or the gateway
 * comes back in words; anything else is thrown, so a dialog keeps its
 * request key.
 *
 * A plain server-only module, not a `'use server'` one: every export of
 * those is an action a browser can call, and this takes the action's own
 * context, which only the action clients build.
 */

export type LiveRead = {
  route: AdminGatewayRouteName
  targetType: string
  name?: string
  tld?: string
  flwRefundId?: string
  params?: Record<string, string>
  query?: Record<string, string | number | undefined>
  reason?: string | undefined
  /** A money action's key, kept on the note so a repeat is recognised. */
  requestKey?: string
  detail?: Record<string, string | number | boolean>
  /**
   * Price-list reads are about the storefront, not a side: their notes are
   * `global` and the gateway is not told a side (§4.3).
   */
  sideless?: boolean
}

export async function liveRead<T>(ctx: AdminContext, read: LiveRead): Promise<AdminResult<T>> {
  // No admin secret here: say live reads are off, before any note is written.
  if (!adminGatewayConfigured()) return refusedResult('ADMIN_DISABLED')
  const side: AdminSide = read.sideless ? 'live' : await getAdminSide(ctx.admin)
  const noteSide = adminRouteSide(read.route, side)
  const target = adminNoteTarget(read.route, {
    side: noteSide,
    ...(read.name ? { name: read.name } : {}),
    ...(read.tld ? { tld: read.tld } : {}),
    ...(read.flwRefundId ? { flwRefundId: read.flwRefundId } : {}),
  })

  const note = await ctx.db.rpc('admin_note', {
    p_action: ADMIN_GATEWAY_ROUTES[read.route].action,
    p_side: noteSide,
    p_target_type: read.targetType,
    p_target_id: target,
    p_detail: read.detail ?? {},
    ...(read.reason ? { p_reason: read.reason } : {}),
    ...(read.requestKey ? { p_request_key: read.requestKey } : {}),
  })
  if (note.error) throw adminAccessError(note.error.message)
  const noted = toAdminResult(note.data)
  if (!noted.ok) return noted

  const query = read.sideless ? read.query : { side, ...read.query }
  try {
    const data = await callAdminGateway<T>({
      admin: ctx.admin,
      auditId: noted.auditId,
      route: ADMIN_GATEWAY_ROUTES[read.route].template,
      ...(read.params ? { params: read.params } : {}),
      ...(query ? { query } : {}),
    })
    return { ok: true, auditId: noted.auditId, data }
  } catch (error) {
    if (error instanceof GatewayError) {
      const reason = (error as GatewayError & { reason?: string }).reason
      return refusedResult(
        error.code === 'ADMIN_NOTE_REFUSED' && reason ? reason : error.code,
        noted.auditId,
      )
    }
    throw error
  }
}
