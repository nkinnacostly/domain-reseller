'use server'

import {
  ADMIN_GATEWAY_ROUTES,
  type AdminCatalogueApply,
  type AdminCataloguePreview,
  type AdminGatewayRouteName,
  adminNoteTarget,
  adminRouteSide,
} from '@dr/shared/admin'
import { GatewayError } from '@dr/shared/errors'
import { revalidateTag } from 'next/cache'
import {
  type AdminResult,
  adminAccessError,
  refusedResult,
  toAdminResult,
} from '@/features/admin/lib/errors'
import { TOPUP_CODE_WORDS } from '@/features/admin/lib/supplier-copy'
import { adminGatewayConfigured, callAdminGateway } from '@/features/admin/queries/gateway'
import {
  applyCatalogueSchema,
  correctTopupSchema,
  previewCatalogueSchema,
  recordTopupSchema,
} from '@/features/admin/schemas/supplier'
import { type AdminContext, adminAction, adminMoneyAction } from '@/lib/safe-action'

/**
 * The owner's Supplier actions (docs/ADMIN-SPEC.md §5.2 B6): previewing and
 * applying the weekly price-list syncs early (D19), and recording what a
 * float top-up cost (§3.2b). Each is validated first; a preview or an apply
 * then writes its audit note (`admin_note`), stops if SQL refuses it, and
 * calls the gateway with the note's id, which the gateway claims before it
 * calls anyone (D22). Top-ups are `admin_*` wrappers, called as the admin.
 */

type Catalogue = 'tlds' | 'ssl'

const PREVIEW_ROUTE: Record<Catalogue, AdminGatewayRouteName> = {
  tlds: 'cataloguePreview',
  ssl: 'sslCataloguePreview',
}

const APPLY_ROUTE: Record<Catalogue, AdminGatewayRouteName> = {
  tlds: 'catalogueApply',
  ssl: 'sslCatalogueApply',
}

/**
 * Note, then gateway. Catalogue reads are about the storefront, not a side:
 * their notes are `global` (§4.3). A refusal from SQL or the gateway comes
 * back in words; anything else is thrown, so the dialog keeps its request key.
 */
async function catalogueCall<T>(
  ctx: AdminContext,
  route: AdminGatewayRouteName,
  extra: { reason?: string | undefined; requestKey?: string } = {},
): Promise<AdminResult<T>> {
  if (!adminGatewayConfigured()) return refusedResult('ADMIN_DISABLED')
  const side = adminRouteSide(route, 'live')
  const note = await ctx.db.rpc('admin_note', {
    p_action: ADMIN_GATEWAY_ROUTES[route].action,
    p_side: side,
    p_target_type: 'catalogue',
    p_target_id: adminNoteTarget(route, { side }),
    p_detail: {},
    ...(extra.reason ? { p_reason: extra.reason } : {}),
    ...(extra.requestKey ? { p_request_key: extra.requestKey } : {}),
  })
  if (note.error) throw adminAccessError(note.error.message)
  const noted = toAdminResult(note.data)
  if (!noted.ok) return noted

  try {
    const data = await callAdminGateway<T>({
      admin: ctx.admin,
      auditId: noted.auditId,
      route: ADMIN_GATEWAY_ROUTES[route].template,
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

/** What the weekly extension sync would change, without writing anything. */
export const previewPriceList = adminAction(
  'supplier.catalogue_preview',
  previewCatalogueSchema,
).action(
  async ({ ctx }): Promise<AdminResult<AdminCataloguePreview>> =>
    catalogueCall(ctx, PREVIEW_ROUTE.tlds),
)

/** What the weekly SSL product sync would change, without writing anything. */
export const previewSslList = adminAction(
  'supplier.ssl_catalogue_preview',
  previewCatalogueSchema,
).action(
  async ({ ctx }): Promise<AdminResult<AdminCataloguePreview>> =>
    catalogueCall(ctx, PREVIEW_ROUTE.ssl),
)

/**
 * An apply that ran: prices on the site are cached under `pricing`, so they
 * are expired now (N5b). A listing the sync refused wrote nothing: that is a
 * refusal, so the dialog says so and takes a new request key.
 */
async function applied(
  result: AdminResult<AdminCatalogueApply>,
): Promise<AdminResult<AdminCatalogueApply>> {
  if (!result.ok) return result
  if (result.data?.outcome === 'refused') {
    return {
      ok: false,
      code: 'CATALOGUE_REFUSED',
      message: `The sync refused the listing, so nothing was written${result.data.reason ? `: ${result.data.reason}` : ''}.`,
      auditId: result.auditId,
    }
  }
  revalidateTag('pricing', { expire: 0 })
  return result
}

/** Apply price list (money, owner, `supplier.catalogue_apply`; §5.2 B6). */
export const applyPriceList = adminMoneyAction(
  'supplier.catalogue_apply',
  applyCatalogueSchema,
).action(async ({ parsedInput, ctx }) =>
  applied(
    await catalogueCall<AdminCatalogueApply>(ctx, APPLY_ROUTE.tlds, {
      reason: parsedInput.reason,
      requestKey: parsedInput.requestKey,
    }),
  ),
)

/** The SSL product list's apply: the same, and it never touches `is_sellable`. */
export const applySslList = adminMoneyAction(
  'supplier.ssl_catalogue_apply',
  applyCatalogueSchema,
).action(async ({ parsedInput, ctx }) =>
  applied(
    await catalogueCall<AdminCatalogueApply>(ctx, APPLY_ROUTE.ssl, {
      reason: parsedInput.reason,
      requestKey: parsedInput.requestKey,
    }),
  ),
)

/** A wrapper's answer, with the top-up's own words for codes it shares with refunds. */
function topupResult(json: unknown): AdminResult {
  const result = toAdminResult(json)
  if (result.ok) return result
  const words = TOPUP_CODE_WORDS[result.code]
  return words ? { ...result, message: words } : result
}

/** Record top-up cost (money, owner, `topup.record`): the naira paid for a live ledger credit. */
export const recordTopup = adminMoneyAction('topup.record', recordTopupSchema).action(
  async ({ parsedInput, ctx }): Promise<AdminResult> => {
    const { data, error } = await ctx.db.rpc('admin_record_float_topup', {
      p_trace_id: parsedInput.traceId,
      p_ngn_paid_kobo: parsedInput.ngnPaidKobo,
      p_reference: parsedInput.reference,
      p_reason: parsedInput.reason,
      p_request_key: parsedInput.requestKey,
    })
    if (error) throw adminAccessError(error.message)
    return topupResult(data)
  },
)

/** Correct a top-up (money, owner, `topup.correct`): a superseding record; the first stays. */
export const correctTopup = adminMoneyAction('topup.correct', correctTopupSchema).action(
  async ({ parsedInput, ctx }): Promise<AdminResult> => {
    const { data, error } = await ctx.db.rpc('admin_correct_float_topup', {
      p_topup_id: parsedInput.topupId,
      p_ngn_paid_kobo: parsedInput.ngnPaidKobo,
      p_reference: parsedInput.reference,
      p_reason: parsedInput.reason,
      p_request_key: parsedInput.requestKey,
    })
    if (error) throw adminAccessError(error.message)
    return topupResult(data)
  },
)
