'use server'

import {
  ADMIN_GATEWAY_ROUTES,
  ADMIN_PRICE_OPS,
  type AdminFlwRefundCheck,
  type AdminGatewayRouteName,
  type AdminLedgerPage,
  type AdminPriceCheck,
  type AdminRegistrantVerification,
  type AdminRegistryDomain,
  type AdminRegistryPage,
  type AdminRenewCheck,
  type AdminSslStatus,
  type AdminSupplierBalance,
  type AdminTransferState,
  adminNoteTarget,
  adminRouteSide,
  RENEW_CHECK_ENABLED,
} from '@dr/shared/admin'
import { GatewayError } from '@dr/shared/errors'
import { z } from 'zod'
import {
  type AdminResult,
  adminAccessError,
  refusedResult,
  toAdminResult,
} from '@/features/admin/lib/errors'
import type { AdminSide } from '@/features/admin/lib/side'
import { callAdminGateway } from '@/features/admin/queries/gateway'
import { getAdminSide } from '@/features/admin/queries/session'
import {
  bigintIdSchema,
  hostnameSchema,
  optionalReasonSchema,
  uuidSchema,
} from '@/features/admin/schemas/common'
import { type AdminContext, adminAction } from '@/lib/safe-action'

/**
 * Live reads through the gateway (docs/ADMIN-SPEC.md §4.3, §5.1, D22). Each
 * one, after its input is validated: writes an intent note with
 * `admin_note`, stops if SQL refuses it, then asks the gateway with the
 * note's id — and the gateway claims the note before it calls anyone. Pages
 * never call these on render: a person presses a button.
 */

type Read<T> = Promise<AdminResult<T>>

type LiveRead = {
  route: AdminGatewayRouteName
  targetType: string
  name?: string
  tld?: string
  flwRefundId?: string
  params?: Record<string, string>
  query?: Record<string, string | number | undefined>
  reason?: string | undefined
  detail?: Record<string, string | number | boolean>
}

async function liveRead<T>(ctx: AdminContext, read: LiveRead): Read<T> {
  const side: AdminSide = await getAdminSide(ctx.admin)
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
  })
  if (note.error) throw adminAccessError(note.error.message)
  const noted = toAdminResult(note.data)
  if (!noted.ok) return noted

  try {
    const data = await callAdminGateway<T>({
      admin: ctx.admin,
      auditId: noted.auditId,
      route: ADMIN_GATEWAY_ROUTES[read.route].template,
      ...(read.params ? { params: read.params } : {}),
      query: { side, ...read.query },
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

const nameInput = z.object({ name: hostnameSchema, reason: optionalReasonSchema })

/** The latest balance, read from the supplier for this side. */
export const readLiveBalance = adminAction('supplier.balance', z.object({})).action(
  async ({ ctx }): Read<AdminSupplierBalance> =>
    liveRead(ctx, { route: 'balance', targetType: 'supplier' }),
)

const dateSchema = z.iso.date()

/** A page of the supplier's own ledger. A POST: a search term never sits in a URL. */
export const searchLiveLedger = adminAction(
  'supplier.ledger_live',
  z.object({
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    skip: z.number().int().min(0).max(10_000).optional(),
    take: z.number().int().min(1).max(100).optional(),
    type: z.number().int().min(0).max(20).optional(),
    productType: z.number().int().min(0).max(20).optional(),
    q: z.string().trim().max(120).optional(),
    trace: z.guid().optional(),
  }),
).action(
  async ({ parsedInput, ctx }): Read<AdminLedgerPage> =>
    liveRead(ctx, {
      route: 'ledger',
      targetType: 'supplier',
      query: {
        from: parsedInput.from,
        to: parsedInput.to,
        skip: parsedInput.skip,
        take: parsedInput.take,
        type: parsedInput.type,
        productType: parsedInput.productType,
        q: parsedInput.q,
        trace: parsedInput.trace?.toLowerCase(),
      },
    }),
)

/** One domain as the registry holds it. */
export const lookupDomain = adminAction('supplier.domain_lookup', nameInput).action(
  async ({ parsedInput, ctx }): Read<AdminRegistryDomain> =>
    liveRead(ctx, {
      route: 'domainLookup',
      targetType: 'domain',
      name: parsedInput.name,
      params: { name: parsedInput.name },
      reason: parsedInput.reason,
    }),
)

/** A page of our account's domains at the registry. */
export const readRegistryPage = adminAction(
  'supplier.domains_page',
  z.object({
    skip: z.number().int().min(0).max(10_000).optional(),
    take: z.number().int().min(1).max(100).optional(),
  }),
).action(
  async ({ parsedInput, ctx }): Read<AdminRegistryPage> =>
    liveRead(ctx, {
      route: 'registryPage',
      targetType: 'supplier',
      query: { skip: parsedInput.skip, take: parsedInput.take },
    }),
)

/** Whether the registrant confirmed their email with the registry. */
export const readRegistrantVerification = adminAction('supplier.verification', nameInput).action(
  async ({ parsedInput, ctx }): Read<AdminRegistrantVerification> =>
    liveRead(ctx, {
      route: 'verification',
      targetType: 'domain',
      name: parsedInput.name,
      params: { name: parsedInput.name },
      reason: parsedInput.reason,
    }),
)

/** Where a transfer stands at the registry (`domains/transfers/query`, a POST read). */
export const readTransferState = adminAction('supplier.transfer_query', nameInput).action(
  async ({ parsedInput, ctx }): Read<AdminTransferState> =>
    liveRead(ctx, {
      route: 'transferQuery',
      targetType: 'domain',
      name: parsedInput.name,
      params: { name: parsedInput.name },
      reason: parsedInput.reason,
    }),
)

/** Whether the registry would renew it (`domains/renew/check`; proven to change nothing). */
export const checkRenewable = adminAction(
  'supplier.renew_check',
  nameInput.extend({ years: z.number().int().min(1).max(10).optional() }),
).action(async ({ parsedInput, ctx }): Read<AdminRenewCheck> => {
  if (!RENEW_CHECK_ENABLED) return refusedResult('DISABLED')
  return liveRead(ctx, {
    route: 'renewCheck',
    targetType: 'domain',
    name: parsedInput.name,
    params: { name: parsedInput.name },
    query: { years: parsedInput.years },
    reason: parsedInput.reason,
  })
})

/** The supplier's price for one operation, against ours. Never for a test admin (SQL says so). */
export const checkSupplierPrice = adminAction(
  'supplier.price_check',
  z.object({
    tld: z
      .string()
      .trim()
      .toLowerCase()
      .transform((value) => value.replace(/^\./, ''))
      .pipe(z.string().regex(/^[a-z0-9-]{2,63}(\.[a-z0-9-]{2,63})*$/)),
    op: z.enum(ADMIN_PRICE_OPS),
    years: z.number().int().min(1).max(10),
  }),
).action(
  async ({ parsedInput, ctx }): Read<AdminPriceCheck> =>
    liveRead(ctx, {
      route: 'priceCheck',
      targetType: 'tld',
      tld: parsedInput.tld,
      params: { tld: parsedInput.tld },
      query: { op: parsedInput.op, years: parsedInput.years },
    }),
)

/** A certificate's status at the supplier, by its name (a wildcard keeps its `*.`). */
export const lookupSsl = adminAction(
  'supplier.ssl_lookup',
  z.object({
    name: z
      .string()
      .trim()
      .toLowerCase()
      .refine((value) => hostnameSchema.safeParse(value.replace(/^\*\./, '')).success, {
        message: 'Not a certificate name',
      }),
    reason: optionalReasonSchema,
  }),
).action(
  async ({ parsedInput, ctx }): Read<AdminSslStatus> =>
    liveRead(ctx, {
      route: 'sslLookup',
      targetType: 'certificate',
      name: parsedInput.name,
      params: { name: parsedInput.name },
      reason: parsedInput.reason,
    }),
)

/**
 * A Flutterwave refund, read for one held refund or incident: the check the
 * "Record a Flutterwave refund" step needs (§5.2 B3). Ids and amounts only.
 */
export const checkFlutterwaveRefund = adminAction(
  'refund.flw_check',
  z
    .object({
      flwRefundId: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_-]{1,64}$/, "That isn't a Flutterwave refund id."),
      refundId: uuidSchema.optional(),
      incidentId: bigintIdSchema.optional(),
    })
    .refine((input) => (input.refundId === undefined) !== (input.incidentId === undefined), {
      message: 'Name one refund or one incident.',
    }),
).action(
  async ({ parsedInput, ctx }): Read<AdminFlwRefundCheck> =>
    liveRead(ctx, {
      route: 'flwRefundCheck',
      targetType: 'flw_refund',
      flwRefundId: parsedInput.flwRefundId,
      params: { flwRefundId: parsedInput.flwRefundId },
      query: parsedInput.refundId
        ? { refund: parsedInput.refundId.toLowerCase() }
        : { incident: parsedInput.incidentId },
      detail: parsedInput.refundId
        ? { refund_id: parsedInput.refundId.toLowerCase() }
        : { incident_id: String(parsedInput.incidentId) },
    }),
)
