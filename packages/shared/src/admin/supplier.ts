import type { LedgerKind } from './ledger'

/**
 * The gateway's `/v1/admin/*` contract (docs/ADMIN-SPEC.md §4.3): what each
 * route answers, and which audited action each one claims before it calls
 * anyone (D22). Every amount is integer cents or kobo (D24); every time is
 * an ISO instant. Personal data never appears here — contacts, auth codes,
 * owner names, CSRs and approvers stay inside the gateway's admin module.
 */

export type AdminSide = 'live' | 'test'
/** Catalogue and price reads are about the storefront, not a side. */
export type AdminNoteSide = AdminSide | 'global'

export type AdminSupplierBalance = {
  side: AdminSide
  balanceCents: number
  priceGroup: string | null
  readAt: string
}

export type AdminLedgerEntry = {
  traceId: string
  occurredAt: string
  type: number
  status: number
  chargeType: number
  productType: number
  description: string
  period: number | null
  /** balance − oldBalance: the supplier's `amount` is always 0. */
  deltaCents: number
  balanceBeforeCents: number
  balanceAfterCents: number
  kind: LedgerKind
}

export type AdminLedgerPage = {
  side: AdminSide
  total: number
  items: AdminLedgerEntry[]
  readAt: string
}

export type AdminRegistryListing = {
  name: string
  status: string | null
  expiresAt: string | null
  rgpExpiresAt: string | null
  transferLock: boolean | null
  privacy: boolean | null
  /** The supplier's word (e.g. "AutoRenew"); not a promise of anything (BACKLOG L18). */
  renewalModeLabel: string | null
  nameservers: string[]
}

export type AdminRegistryPage = {
  side: AdminSide
  total: number
  items: AdminRegistryListing[]
  readAt: string
}

export type AdminRegistryDomain = {
  name: string
  outcome: 'ok' | 'not_found'
  status: string | null
  statusCode: string | null
  expiresAt: string | null
  rgpExpiresAt: string | null
  transferLock: boolean | null
  privacy: boolean | null
  nameservers: string[]
  readAt: string
}

/** Whether the registrant confirmed their email with the registry (ICANN verification). */
export type AdminRegistrantVerification = {
  name: string
  isVerified: boolean
  operationStatus: string | null
  verifiedAt: string | null
  /** The kind of field verified ("Email"), never its value. */
  fieldType: string | null
  readAt: string
}

export const ADMIN_TRANSFER_STATES = [
  'pending',
  'completed',
  'rejected',
  'cancelled',
  'unknown',
] as const
export type AdminTransferStateWord = (typeof ADMIN_TRANSFER_STATES)[number]

export type AdminTransferState = {
  name: string
  state: AdminTransferStateWord
  /** The supplier's own word, at most 40 characters, for the record only. */
  supplierStatus: string | null
  requestedAt: string | null
  finalAt: string | null
  readAt: string
}

export type AdminRenewCheck = {
  name: string
  renewable: boolean
  renewalLock: boolean
  /** Our key for why not (e.g. `PERIOD_NOT_ALLOWED`), never the supplier's text (N10). */
  reasonKey: string | null
  readAt: string
}

export const ADMIN_PRICE_OPS = ['register', 'renew', 'transfer', 'restore'] as const
export type AdminPriceOp = (typeof ADMIN_PRICE_OPS)[number]

export type AdminPriceCheck = {
  tld: string
  op: AdminPriceOp
  years: number
  supplierCents: number
  ourCents: number | null
  matches: boolean
  readAt: string
}

export type AdminCataloguePreview = {
  kind: 'tlds' | 'ssl'
  outcome: 'ok' | 'refused' | 'failed'
  reason: string | null
  listed: number
  sellable: number
  changes: number
  /** At most 200 lines of the sync's own report. */
  report: string[]
  readAt: string
}

export type AdminCatalogueApply = {
  outcome: 'applied' | 'refused' | 'failed'
  reason: string | null
  changes: number
  readAt: string
}

export type AdminSslStatus = {
  name: string
  outcome: 'ok' | 'not_found'
  status: string | null
  isConfigured: boolean | null
  isIssued: boolean | null
  certificateExpiresAt: string | null
  subscriptionEndsAt: string | null
  validUntil: string | null
  readAt: string
}

export type AdminFlwRefundCheck = {
  checkId: number
  flwRefundId: string
  transactionId: string | null
  amountKobo: number
  status: string
  state: 'done' | 'failed' | 'pending'
  readAt: string
}

export type AdminPresetDraftCheck = {
  ok: boolean
  hosts: { host: string; ok: boolean }[]
  checkedAt: string
}

/** The admin actions the gateway claims a note for (D22). */
export type AdminGatewayAction =
  | 'supplier.balance'
  | 'supplier.ledger_live'
  | 'supplier.domains_page'
  | 'supplier.domain_lookup'
  | 'supplier.verification'
  | 'supplier.transfer_query'
  | 'supplier.renew_check'
  | 'supplier.price_check'
  | 'supplier.catalogue_preview'
  | 'supplier.ssl_catalogue_preview'
  | 'supplier.catalogue_apply'
  | 'supplier.ssl_catalogue_apply'
  | 'supplier.ssl_lookup'
  | 'refund.flw_check'
  | 'preset.draft_check'

export type AdminGatewayRoute = {
  method: 'GET' | 'POST'
  /** Relative to `/v1/`. Logged as is: never a filled path (N13). */
  template: string
  action: AdminGatewayAction
}

/** Every `/v1/admin/*` route, by name. The web and the gateway both read this. */
export const ADMIN_GATEWAY_ROUTES = {
  balance: { method: 'GET', template: 'admin/supplier/balance', action: 'supplier.balance' },
  ledger: {
    method: 'GET',
    template: 'admin/supplier/transactions',
    action: 'supplier.ledger_live',
  },
  registryPage: {
    method: 'GET',
    template: 'admin/supplier/domains',
    action: 'supplier.domains_page',
  },
  domainLookup: {
    method: 'GET',
    template: 'admin/supplier/domains/:name',
    action: 'supplier.domain_lookup',
  },
  verification: {
    method: 'GET',
    template: 'admin/supplier/domains/:name/verification',
    action: 'supplier.verification',
  },
  transferQuery: {
    method: 'GET',
    template: 'admin/supplier/domains/:name/transfer',
    action: 'supplier.transfer_query',
  },
  renewCheck: {
    method: 'GET',
    template: 'admin/supplier/domains/:name/renewable',
    action: 'supplier.renew_check',
  },
  priceCheck: {
    method: 'GET',
    template: 'admin/supplier/prices/:tld',
    action: 'supplier.price_check',
  },
  cataloguePreview: {
    method: 'GET',
    template: 'admin/supplier/catalogue/preview',
    action: 'supplier.catalogue_preview',
  },
  sslCataloguePreview: {
    method: 'GET',
    template: 'admin/supplier/ssl-catalogue/preview',
    action: 'supplier.ssl_catalogue_preview',
  },
  catalogueApply: {
    method: 'POST',
    template: 'admin/supplier/catalogue/apply',
    action: 'supplier.catalogue_apply',
  },
  sslCatalogueApply: {
    method: 'POST',
    template: 'admin/supplier/ssl-catalogue/apply',
    action: 'supplier.ssl_catalogue_apply',
  },
  sslLookup: { method: 'GET', template: 'admin/supplier/ssl/:name', action: 'supplier.ssl_lookup' },
  flwRefundCheck: {
    method: 'GET',
    template: 'admin/flutterwave/refunds/:flwRefundId',
    action: 'refund.flw_check',
  },
  presetDraftCheck: {
    method: 'POST',
    template: 'admin/presets/drafts/:id/check',
    action: 'preset.draft_check',
  },
} as const satisfies Record<string, AdminGatewayRoute>

export type AdminGatewayRouteName = keyof typeof ADMIN_GATEWAY_ROUTES

/**
 * `domains/renew/check` changes nothing at the supplier: proven in the OTE
 * sandbox on 2 and 3 Oct 2026 — balance $616.21, expiry 2027-09-23 and 17
 * ledger entries before and after (§9 A acceptance). The proof is
 * `apps/gateway/scripts/prove-renew-check.ts` (`pnpm --filter @dr/gateway
 * prove:renew-check`), its last run recorded in
 * `apps/gateway/scripts/fixtures/renew-check-ote.json`, which
 * `apps/gateway/src/admin/supplier.test.ts` holds this flag to. Flip to false
 * to take the route off; NOT_RENEWABLE then shows only the playbook text.
 */
export const RENEW_CHECK_ENABLED = true

/** Fills a template's `:params`, each URL-encoded; a missing one throws. */
export function fillRoute(template: string, params: Readonly<Record<string, string>> = {}): string {
  return template.replace(/:([A-Za-z]+)/g, (_, key: string) => {
    const value = params[key]
    if (value === undefined || value === '') throw new Error(`Missing route parameter ${key}`)
    return encodeURIComponent(value)
  })
}

/** Catalogue, price and preset reads are about the storefront: their notes are `global`. */
const GLOBAL_ROUTES: ReadonlySet<AdminGatewayRouteName> = new Set([
  'priceCheck',
  'cataloguePreview',
  'sslCataloguePreview',
  'catalogueApply',
  'sslCatalogueApply',
  'presetDraftCheck',
])

/** The side a route's note is written and claimed on. */
export function adminRouteSide(route: AdminGatewayRouteName, side: AdminSide): AdminNoteSide {
  return GLOBAL_ROUTES.has(route) ? 'global' : side
}

/**
 * The note target each route claims (D22), from the same inputs the gateway
 * validates: the normalised name, tld, refund id or draft id — or the side
 * itself for side-wide reads.
 */
export function adminNoteTarget(
  route: AdminGatewayRouteName,
  input: { side: AdminNoteSide; name?: string; tld?: string; flwRefundId?: string; id?: string },
): string {
  switch (route) {
    case 'domainLookup':
    case 'verification':
    case 'transferQuery':
    case 'renewCheck':
    case 'sslLookup':
      if (!input.name) throw new Error('A name is required')
      return input.name
    case 'priceCheck':
      if (!input.tld) throw new Error('An extension is required')
      return input.tld
    case 'flwRefundCheck':
      if (!input.flwRefundId) throw new Error('A refund id is required')
      return input.flwRefundId
    case 'presetDraftCheck':
      if (!input.id) throw new Error('A draft id is required')
      return input.id
    case 'cataloguePreview':
    case 'catalogueApply':
      return 'tlds'
    case 'sslCataloguePreview':
    case 'sslCatalogueApply':
      return 'ssl'
    default:
      return input.side
  }
}
