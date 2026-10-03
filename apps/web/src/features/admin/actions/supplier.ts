'use server'

import type {
  AdminCatalogueApply,
  AdminCataloguePreview,
  AdminGatewayRouteName,
} from '@dr/shared/admin'
import { revalidateTag } from 'next/cache'
import { liveRead } from '@/features/admin/actions/live-read'
import { type AdminResult, adminAccessError, toAdminResult } from '@/features/admin/lib/errors'
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
 * Note, then gateway (`liveRead`). Price lists are about the storefront, not
 * a side: their notes are `global`, and the gateway is not told a side (§4.3).
 */
function catalogueCall<T>(
  ctx: AdminContext,
  route: AdminGatewayRouteName,
  extra: { reason?: string | undefined; requestKey?: string } = {},
): Promise<AdminResult<T>> {
  return liveRead<T>(ctx, {
    route,
    targetType: 'catalogue',
    sideless: true,
    reason: extra.reason,
    ...(extra.requestKey ? { requestKey: extra.requestKey } : {}),
  })
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
    return toAdminResult(data)
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
    return toAdminResult(data)
  },
)
