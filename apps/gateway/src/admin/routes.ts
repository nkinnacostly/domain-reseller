import {
  ADMIN_GATEWAY_ROUTES,
  type AdminCatalogueApply,
  type AdminCataloguePreview,
  type AdminFlwRefundCheck,
  type AdminGatewayRouteName,
  type AdminLedgerPage,
  type AdminNoteSide,
  type AdminPresetDraftCheck,
  type AdminPriceCheck,
  type AdminPriceOp,
  type AdminRegistrantVerification,
  type AdminRegistryDomain,
  type AdminRegistryPage,
  type AdminRenewCheck,
  type AdminSide,
  type AdminSslStatus,
  type AdminSupplierBalance,
  type AdminTransferState,
  adminNoteTarget,
  adminRouteSide,
  RENEW_CHECK_ENABLED,
  usdToCents,
} from '@dr/shared/admin'
import { mapSupplierError } from '@dr/shared/errors'
import { type Context, Hono } from 'hono'
import { routePath } from 'hono/route'
import type { WriteTarget } from '../dna/client'
import type { JsonResponse } from '../lib/http'
import { TokenBucket } from '../lib/rate-limit'
import { QueueTimeout } from '../lib/semaphore'
import { TtlCache } from '../lib/ttl-cache'
import { type Flutterwave, refundState } from '../payments/flutterwave'
import type { Lookup } from '../provisioning/registrar'
import type { SslClient } from '../ssl/client'
import { type AdminVariables, requireAdminCaller } from './auth'
import type { AdminStore, DraftForCheck, NoteOutcome, NoteStore } from './notes'
import {
  errorCode,
  sellingCents,
  toBalance,
  toLedgerEntry,
  toRegistryListing,
  toRenewCheck,
  toTransferState,
  toVerification,
} from './shapes'
import { type AdminSupplier, NotAllowed } from './supplier'
import {
  validFlwRefundId,
  validId,
  validName,
  validOp,
  validQuery,
  validRange,
  validSide,
  validSkip,
  validSmallInt,
  validTake,
  validTld,
  validTrace,
  validYears,
} from './validate'

/**
 * `/v1/admin/*` (docs/ADMIN-SPEC.md §4): live reads for the admin dashboard,
 * behind the gateway secret and the admin secret, each claiming the web's
 * audited intent note before anything else (D22). Reads only: the supplier
 * through `createAdminSupplier`'s allowlist, a registry lookup, a
 * certificate's status, a Flutterwave refund, public DNS for a preset draft,
 * and the catalogue sync the gateway already runs weekly (D19). Never in the
 * `high` lane (D10); nothing here is called while a page renders.
 */

type Log = {
  info(fields: object, message: string): void
  warn(fields: object, message: string): void
  error(fields: object, message: string): void
}

/** A route's work that did not answer: refused (our rule) or failed (theirs). */
type Failure = {
  status: 'refused' | 'failed'
  httpStatus: 400 | 403 | 404 | 409 | 429 | 500 | 502 | 503
  code: string
  message: string
  detail?: Record<string, unknown>
}

/** The outcome of the work behind one route, before it is answered and recorded. */
type Outcome<T> = { status: 'ok'; data: T; detail?: Record<string, unknown> } | Failure

export type CatalogueRun = {
  outcome: 'unchanged' | 'changes' | 'written' | 'refused'
  reason: string | null
  listed: number
  sellable: number
  changes: number
  report: string[]
}

export type CatalogueActions = {
  preview(): Promise<CatalogueRun>
  /** Writes what it trusts, refreshes the site's prices and beats the heartbeat. */
  apply(): Promise<CatalogueRun>
}

export type TldCost = NonNullable<Awaited<ReturnType<AdminStore['tldCost']>>>

export type AdminRouterDeps = {
  secret: string | undefined
  /** The side this gateway registers on; `off` reads no side. */
  target: 'off' | WriteTarget
  notes: NoteStore
  store: AdminStore
  /** The supplier on the target side's key: balance, ledger, the registry listing. */
  targetSupplier: () => AdminSupplier | null
  /** The supplier on DNA_ENV's key: prices. */
  catalogueSupplier: () => AdminSupplier | null
  /** GetDetails on the target side, recorded as AdminGetDetails. */
  lookup: () => ((name: string) => Promise<Lookup>) | null
  /** Certificate reads on the target side, recorded as AdminSsl*. */
  ssl: () => Pick<SslClient, 'status' | 'details'> | null
  flutterwave: () => Pick<Flutterwave, 'getRefund'> | null
  catalogue: () => CatalogueActions | null
  sslCatalogue: () => CatalogueActions | null
  checkDraft: (draft: DraftForCheck) => Promise<AdminPresetDraftCheck>
  /** 20 at once, then one every two seconds, across every admin route. */
  bucket: TokenBucket
  /** Flutterwave is not the supplier: its own allowance. */
  flwBucket: TokenBucket
  now: () => Date
  log: Log
}

const SIDE_OF: Record<WriteTarget, AdminSide> = { ote: 'test', production: 'live' }
const ORDER_TYPE: Record<AdminPriceOp, number> = { register: 1, renew: 2, transfer: 3, restore: 4 }
const DAY_MS = 86_400_000
/**
 * How many listing items a verification reads to find its own domain: the
 * supplier's DomainName filter also returns names that contain it, so the
 * exact one need not be first (§4.3).
 */
const VERIFICATION_LISTING_SIZE = 25
const LANES = {
  normal10: { priority: 'normal', waitMs: 10_000 },
  normal12: { priority: 'normal', waitMs: 12_000 },
  low15: { priority: 'low', waitMs: 15_000 },
} as const

/** A UTC+3 calendar date (the supplier's), `days` from an instant. */
function supplierDay(at: number, days: number): string {
  return new Date(at + 3 * 3_600_000 + days * DAY_MS).toISOString().slice(0, 10)
}

const refused = (
  httpStatus: 400 | 403 | 404 | 409 | 429 | 503,
  code: string,
  message: string,
  detail: Record<string, unknown> = {},
): Failure => ({ status: 'refused', httpStatus, code, message, detail })

/** A supplier answer that is not a 2xx, as our code and words (N10). */
function supplierFailure(answer: JsonResponse): Failure {
  const code = errorCode(answer.body)
  if (code === 'API_301' || answer.status === 401) {
    const mapped = mapSupplierError(code === 'API_301' ? 'API_301' : 'CREDENTIALS')
    return {
      status: 'failed',
      httpStatus: 502,
      code: mapped.code,
      message: mapped.message,
      detail: { http: answer.status },
    }
  }
  if (code === 'API_429' || answer.status === 429) {
    return {
      status: 'refused',
      httpStatus: 503,
      code: 'SUPPLIER_BUSY',
      message: 'The supplier is busy. Try again shortly.',
      detail: { http: 429 },
    }
  }
  const mapped = mapSupplierError(code ?? `HTTP_${answer.status}`)
  return {
    status: 'failed',
    httpStatus: 502,
    code: mapped.code,
    message: mapped.message,
    detail: { http: answer.status, supplierCode: code },
  }
}

const ok = (answer: JsonResponse) => answer.status >= 200 && answer.status < 300

/** The one refund or incident a refund.flw_check note was written for, from its detail. */
export function flwTarget(
  detail: Readonly<Record<string, unknown>>,
): { type: 'refund' | 'incident'; id: string } | null {
  const refund = detail.refund_id
  const incident = detail.incident_id
  if (typeof refund === 'string' && incident === undefined) {
    const id = validId(refund, 'uuid')
    return id ? { type: 'refund', id } : null
  }
  if (typeof incident === 'string' && refund === undefined) {
    const id = validId(incident, 'bigint')
    return id ? { type: 'incident', id } : null
  }
  return null
}

/** What `tlds` says the supplier charges for this op and term, in cents (N5b). */
export function ourCostCents(cost: TldCost, op: AdminPriceOp, years: number): number | null {
  const first = Math.max(1, cost.firstTermYears)
  switch (op) {
    case 'register':
      if (years < first) return null
      return usdToCents(cost.registerUsd) * first + usdToCents(cost.renewUsd) * (years - first)
    case 'renew':
      return usdToCents(cost.renewUsd) * years
    case 'transfer':
      return cost.transferUsd === null ? null : usdToCents(cost.transferUsd)
    case 'restore':
      return cost.restoreUsd === null ? null : usdToCents(cost.restoreUsd)
  }
}

function toPreview(kind: 'tlds' | 'ssl', run: CatalogueRun, readAt: string): AdminCataloguePreview {
  return {
    kind,
    outcome: run.outcome === 'refused' ? 'refused' : 'ok',
    reason: run.reason,
    listed: run.listed,
    sellable: run.sellable,
    changes: run.changes,
    report: run.report.slice(0, 200),
    readAt,
  }
}

export function createAdminRouter(deps: AdminRouterDeps) {
  const caches = {
    balance: new TtlCache<AdminSupplierBalance>(30_000, 4),
    ledger: new TtlCache<AdminLedgerPage>(60_000, 200),
    registry: new TtlCache<AdminRegistryPage>(5 * 60_000, 200),
    verification: new TtlCache<AdminRegistrantVerification | null>(3_600_000, 500),
    price: new TtlCache<AdminPriceCheck>(10 * 60_000, 500),
    preview: new TtlCache<AdminCataloguePreview>(10 * 60_000, 2),
  }
  /** One call per name per 30 s for the reads that are never cached. */
  const throttle = new TtlCache<true>(30_000, 5_000)
  /** One apply per catalogue per 10 minutes; one preview in flight. */
  const applied = new TtlCache<true>(10 * 60_000, 4)
  const previews = new Map<string, Promise<CatalogueRun>>()
  /** One public-DNS check per draft per minute. */
  const draftChecks = new TtlCache<true>(60_000, 500)

  const router = new Hono<{ Variables: AdminVariables }>()
  const readAt = () => deps.now().toISOString()

  router.use('*', async (c, next) => {
    const started = Date.now()
    await next()
    const caller = c.get('adminCaller')
    // The route template, never the filled path: no domain name in a log (N13).
    deps.log.info(
      {
        route: routePath(c, -1),
        adminLabel: caller?.label,
        auditId: caller?.auditId,
        ms: Date.now() - started,
        outcome: c.res.status,
      },
      'admin request',
    )
    c.header('Cache-Control', 'no-store')
  })
  router.use('*', requireAdminCaller(deps.secret))

  /** The side a request names must be the one this gateway reads (409 otherwise). */
  function sideOf(c: Context): { side: AdminSide } | { error: Failure } {
    const asked = validSide(c.req.query('side'))
    if (!asked) return { error: refused(400, 'VALIDATION_FAILED', 'A side is required') }
    if (deps.target === 'off') {
      return { error: refused(503, 'WRITES_OFF', 'This gateway reads no side: its writes are off') }
    }
    if (SIDE_OF[deps.target] !== asked) {
      return {
        error: refused(409, 'OTHER_SIDE', `This gateway reads the ${SIDE_OF[deps.target]} side`),
      }
    }
    return { side: asked }
  }

  function answer<T>(c: Context, outcome: Outcome<T>) {
    if (outcome.status === 'ok') return c.json({ ok: true, data: outcome.data })
    return c.json(
      {
        ok: false,
        code: outcome.code,
        message: outcome.message,
        retryable: outcome.httpStatus >= 500,
      },
      outcome.httpStatus,
    )
  }

  /**
   * The order every route keeps: inputs (before), the allowance, the claim,
   * then the work; then the result against the note. Nothing reaches the
   * supplier, Flutterwave or DNS before the claim succeeds.
   */
  async function handle<T>(
    c: Context<{ Variables: AdminVariables }>,
    route: AdminGatewayRouteName,
    noteSide: AdminNoteSide,
    target: string,
    work: (note: { detail: Readonly<Record<string, unknown>> }) => Promise<Outcome<T>>,
    bucket: TokenBucket = deps.bucket,
  ) {
    const caller = c.get('adminCaller')
    if (!bucket.tryConsume()) {
      return answer(c, refused(429, 'RATE_LIMITED', 'Too many admin lookups. Try again shortly.'))
    }
    const action = ADMIN_GATEWAY_ROUTES[route].action
    const claim = await deps.notes.claim(caller.auditId, action, caller.label, noteSide, target)
    if (!claim.ok) {
      return c.json(
        {
          ok: false,
          code: 'ADMIN_NOTE_REFUSED',
          reason: claim.code,
          message: 'The audit note was refused',
        },
        403,
      )
    }

    let outcome: Outcome<T>
    try {
      outcome = await work({ detail: claim.detail })
    } catch (error) {
      if (error instanceof QueueTimeout) {
        outcome = refused(503, 'SUPPLIER_BUSY', 'The supplier is busy. Try again shortly.')
      } else if (error instanceof NotAllowed) {
        deps.log.error({ route: ADMIN_GATEWAY_ROUTES[route].template }, 'admin call not allowed')
        outcome = {
          status: 'failed',
          httpStatus: 500,
          code: 'NOT_ALLOWED',
          message: 'That read is not allowed',
        }
      } else {
        deps.log.error(
          { route: ADMIN_GATEWAY_ROUTES[route].template, err: error },
          'admin read failed',
        )
        const mapped = mapSupplierError('UNKNOWN')
        outcome = { status: 'failed', httpStatus: 502, code: mapped.code, message: mapped.message }
      }
    }

    const result: NoteOutcome = outcome.status
    try {
      await deps.notes.result(
        caller.auditId,
        result,
        outcome.status === 'ok' ? null : outcome.code,
        outcome.detail ?? {},
      )
    } catch (error) {
      deps.log.error({ auditId: caller.auditId, err: error }, 'admin result not recorded')
    }
    return answer(c, outcome)
  }

  /** At most one uncached read per name per 30 seconds. */
  function throttled(key: string): Failure | null {
    if (throttle.get(key)) {
      return refused(
        429,
        'TOO_SOON',
        'This was read moments ago. Wait 30 seconds before reading it again.',
      )
    }
    throttle.set(key, true)
    return null
  }

  router.get('/supplier/balance', async (c) => {
    const at = sideOf(c)
    if ('error' in at) return answer(c, at.error)
    return handle(
      c,
      'balance',
      at.side,
      adminNoteTarget('balance', { side: at.side }),
      async () => {
        const cached = caches.balance.get(at.side)
        if (cached)
          return {
            status: 'ok',
            data: cached,
            detail: { cents: cached.balanceCents, cached: true },
          }
        const supplier = deps.targetSupplier()
        if (!supplier) return refused(503, 'WRITES_OFF', 'No supplier key for this side')
        const reply = await supplier.get('/deposit/accounts/me', {}, LANES.normal10)
        if (!ok(reply)) return supplierFailure(reply)
        const data = toBalance(reply.body, at.side, readAt())
        if (!data)
          return {
            status: 'failed',
            httpStatus: 502,
            code: 'UNREADABLE',
            message: 'The balance could not be read',
          }
        caches.balance.set(at.side, data)
        return { status: 'ok', data, detail: { cents: data.balanceCents } }
      },
    )
  })

  router.get('/supplier/transactions', async (c) => {
    const at = sideOf(c)
    if ('error' in at) return answer(c, at.error)
    const now = deps.now()
    const range = validRange(c.req.query('from'), c.req.query('to'), now)
    const skip = validSkip(c.req.query('skip'))
    const take = validTake(c.req.query('take'))
    const typeText = c.req.query('type')
    const productText = c.req.query('productType')
    const type = typeText === undefined ? undefined : validSmallInt(typeText)
    const productType = productText === undefined ? undefined : validSmallInt(productText)
    const qText = c.req.query('q')
    const q = qText === undefined ? undefined : validQuery(qText)
    const traceText = c.req.query('trace')
    const trace = traceText === undefined ? undefined : validTrace(traceText)
    if (
      !range ||
      skip === null ||
      take === null ||
      type === null ||
      productType === null ||
      q === null ||
      trace === null
    ) {
      return answer(c, refused(400, 'VALIDATION_FAILED', 'Check the dates, filters and paging'))
    }
    return handle(c, 'ledger', at.side, adminNoteTarget('ledger', { side: at.side }), async () => {
      const key = JSON.stringify([at.side, range, skip, take, type, productType, q, trace])
      const cached = caches.ledger.get(key)
      if (cached)
        return { status: 'ok', data: cached, detail: { count: cached.items.length, cached: true } }
      const supplier = deps.targetSupplier()
      if (!supplier) return refused(503, 'WRITES_OFF', 'No supplier key for this side')
      const fromAt = Date.parse(`${range.from}T00:00:00Z`)
      const toAt = Date.parse(`${range.to}T00:00:00Z`) + DAY_MS
      // The supplier ignores StartDate without EndDate and filters by whole
      // UTC+3 days: always both, widened a day, then filtered back in UTC.
      const params: Record<string, string | number> = {
        StartDate: supplierDay(fromAt, -1),
        EndDate: supplierDay(toAt, 1),
        Sorting: 'creationTime desc',
        SkipCount: skip,
        MaxResultCount: take,
      }
      if (type !== undefined) params.TransactionTypes = type
      if (productType !== undefined) params.ProductTypes = productType
      if (q) params.FilterText = q
      if (trace) params.TraceId = trace
      const reply = await supplier.get('/deposit/transactions', params, LANES.low15)
      if (!ok(reply)) return supplierFailure(reply)
      const body = (reply.body ?? {}) as { items?: unknown; totalCount?: unknown }
      const items = (Array.isArray(body.items) ? body.items : [])
        .map(toLedgerEntry)
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .filter((entry) => {
          const t = Date.parse(entry.occurredAt)
          return t >= fromAt && t < toAt
        })
      const data: AdminLedgerPage = {
        side: at.side,
        total: typeof body.totalCount === 'number' ? body.totalCount : items.length,
        items,
        readAt: readAt(),
      }
      caches.ledger.set(key, data)
      return { status: 'ok', data, detail: { count: items.length, total: data.total } }
    })
  })

  router.get('/supplier/domains', async (c) => {
    const at = sideOf(c)
    if ('error' in at) return answer(c, at.error)
    const skip = validSkip(c.req.query('skip'))
    const take = validTake(c.req.query('take'))
    const nameText = c.req.query('name')
    const name = nameText === undefined ? undefined : validName(nameText)
    if (skip === null || take === null || name === null) {
      return answer(c, refused(400, 'VALIDATION_FAILED', 'Check the name and paging'))
    }
    return handle(
      c,
      'registryPage',
      at.side,
      adminNoteTarget('registryPage', { side: at.side }),
      async () => {
        const key = JSON.stringify([at.side, skip, take, name])
        const cached = caches.registry.get(key)
        if (cached)
          return {
            status: 'ok',
            data: cached,
            detail: { count: cached.items.length, cached: true },
          }
        const supplier = deps.targetSupplier()
        if (!supplier) return refused(503, 'WRITES_OFF', 'No supplier key for this side')
        const params: Record<string, string | number> = { SkipCount: skip, MaxResultCount: take }
        if (name) params.DomainName = name
        const reply = await supplier.get('/domains', params, LANES.low15)
        if (!ok(reply)) return supplierFailure(reply)
        const body = (reply.body ?? {}) as { items?: unknown; totalCount?: unknown }
        const items = (Array.isArray(body.items) ? body.items : [])
          .map(toRegistryListing)
          .filter((item): item is NonNullable<typeof item> => item !== null)
        const data: AdminRegistryPage = {
          side: at.side,
          total: typeof body.totalCount === 'number' ? body.totalCount : items.length,
          items,
          readAt: readAt(),
        }
        caches.registry.set(key, data)
        return { status: 'ok', data, detail: { count: items.length, total: data.total } }
      },
    )
  })

  router.get('/supplier/domains/:name', async (c) => {
    const at = sideOf(c)
    if ('error' in at) return answer(c, at.error)
    const name = validName(c.req.param('name'))
    if (!name) return answer(c, refused(400, 'VALIDATION_FAILED', 'Not a domain name'))
    return handle(c, 'domainLookup', at.side, name, async () => {
      const soon = throttled(`lookup:${at.side}:${name}`)
      if (soon) return soon
      const lookup = deps.lookup()
      if (!lookup) return refused(503, 'WRITES_OFF', 'This gateway reads no side')
      const found = await lookup(name)
      const now = readAt()
      if (found.kind === 'not_found') {
        const data: AdminRegistryDomain = {
          name,
          outcome: 'not_found',
          status: null,
          statusCode: null,
          expiresAt: null,
          rgpExpiresAt: null,
          transferLock: null,
          privacy: null,
          nameservers: [],
          readAt: now,
        }
        return { status: 'ok', data, detail: { found: false } }
      }
      if (found.kind !== 'found') {
        const mapped = mapSupplierError(
          found.code === 'SUPPLIER_IP_BLOCKED' ? 'API_301' : found.code,
        )
        return {
          status: 'failed',
          httpStatus: found.code === 'TIMEOUT' ? 503 : 502,
          code: found.kind === 'blocked' ? found.code : mapped.code,
          message: mapped.message,
          detail: { kind: found.kind },
        }
      }
      const data: AdminRegistryDomain = {
        name,
        outcome: 'ok',
        status: found.domain.status ?? null,
        statusCode: null,
        expiresAt: found.domain.expiresAt,
        rgpExpiresAt: null,
        transferLock: found.domain.transferLock,
        privacy: found.domain.privacy,
        nameservers: found.domain.nameservers,
        readAt: now,
      }
      return { status: 'ok', data, detail: { found: true } }
    })
  })

  router.get('/supplier/domains/:name/verification', async (c) => {
    const at = sideOf(c)
    if ('error' in at) return answer(c, at.error)
    const name = validName(c.req.param('name'))
    if (!name) return answer(c, refused(400, 'VALIDATION_FAILED', 'Not a domain name'))
    return handle(c, 'verification', at.side, name, async () => {
      const key = `${at.side}:${name}`
      const cached = caches.verification.get(key)
      if (cached !== undefined) return { status: 'ok', data: cached, detail: { cached: true } }
      const supplier = deps.targetSupplier()
      if (!supplier) return refused(503, 'WRITES_OFF', 'No supplier key for this side')
      const listing = await supplier.get(
        '/domains',
        { DomainName: name, MaxResultCount: VERIFICATION_LISTING_SIZE },
        LANES.low15,
      )
      if (!ok(listing)) return supplierFailure(listing)
      const items = ((listing.body ?? {}) as { items?: unknown }).items
      // DomainName matches by containing the name (`shop.com` lists
      // `myshop.com`), in no promised order: only the item that is this
      // domain, compared whole and case-blind, may give the handle. Anything
      // else would show — and cache for an hour — another domain's
      // verification; no exact item is "not found".
      const own = Array.isArray(items)
        ? (items as { domainName?: unknown; contacts?: unknown }[]).find(
            (item) =>
              typeof item?.domainName === 'string' && item.domainName.trim().toLowerCase() === name,
          )
        : undefined
      // The registrant's handle is used for the next call and nothing else (N13).
      const handle = (own?.contacts as Record<string, unknown> | undefined)?.Registrant
      if (typeof handle !== 'string' || handle === '') {
        caches.verification.set(key, null)
        return { status: 'ok', data: null, detail: { found: false } }
      }
      const reply = await supplier.get(
        '/contacts/verification/check',
        { HandleCode: handle },
        LANES.low15,
      )
      if (!ok(reply)) return supplierFailure(reply)
      const data = toVerification(reply.body, name, readAt())
      caches.verification.set(key, data)
      return { status: 'ok', data, detail: { verified: data?.isVerified ?? null } }
    })
  })

  router.get('/supplier/domains/:name/transfer', async (c) => {
    const at = sideOf(c)
    if ('error' in at) return answer(c, at.error)
    const name = validName(c.req.param('name'))
    if (!name) return answer(c, refused(400, 'VALIDATION_FAILED', 'Not a domain name'))
    return handle(c, 'transferQuery', at.side, name, async () => {
      const soon = throttled(`transfer:${at.side}:${name}`)
      if (soon) return soon
      const supplier = deps.targetSupplier()
      if (!supplier || deps.target === 'off')
        return refused(503, 'WRITES_OFF', 'No supplier key for this side')
      const started = Date.now()
      const reply = await supplier.postRead(
        '/domains/transfers/query',
        { domainName: name },
        LANES.normal12,
      )
      const code = errorCode(reply.body)
      let data: AdminTransferState
      if (ok(reply)) {
        data = toTransferState(reply.body, name, readAt())
      } else if (
        code === 'Dna.DomainService:Domain:10025' ||
        code === 'Dna.DomainService:Domain:10007'
      ) {
        // "Not in transfer status" / not found: an answer, but not a refusal of a transfer.
        data = {
          name,
          state: 'unknown',
          supplierStatus: code.endsWith('10025') ? 'not_in_transfer' : 'not_found',
          requestedAt: null,
          finalAt: null,
          readAt: readAt(),
        }
      } else {
        await deps.store.recordCall(deps.target, {
          operation: 'AdminTransferQuery',
          domainName: name,
          outcome: reply.status >= 500 ? 'unknown' : 'rejected',
          httpStatus: reply.status,
          errorCode: code,
          message: null,
          durationMs: Date.now() - started,
        })
        return supplierFailure(reply)
      }
      // admin_fail_job reads this row: `message` is the mapped state, never the supplier's text.
      await deps.store.recordCall(deps.target, {
        operation: 'AdminTransferQuery',
        domainName: name,
        outcome: ok(reply) ? 'ok' : 'not_found',
        httpStatus: reply.status,
        errorCode: ok(reply) ? null : code,
        message: data.state,
        durationMs: Date.now() - started,
      })
      return { status: 'ok', data, detail: { state: data.state } }
    })
  })

  router.get('/supplier/domains/:name/renewable', async (c) => {
    if (!RENEW_CHECK_ENABLED) {
      return answer(c, refused(404, 'DISABLED', 'The renewability check is off'))
    }
    const at = sideOf(c)
    if ('error' in at) return answer(c, at.error)
    const name = validName(c.req.param('name'))
    const years = validYears(c.req.query('years'))
    if (!name || years === null)
      return answer(c, refused(400, 'VALIDATION_FAILED', 'A domain name and 1–10 years'))
    return handle(c, 'renewCheck', at.side, name, async () => {
      const soon = throttled(`renew:${at.side}:${name}`)
      if (soon) return soon
      const supplier = deps.targetSupplier()
      if (!supplier || deps.target === 'off')
        return refused(503, 'WRITES_OFF', 'No supplier key for this side')
      const started = Date.now()
      const reply = await supplier.postRead(
        '/domains/renew/check',
        { domainName: name, period: years },
        LANES.normal12,
      )
      const data: AdminRenewCheck | null = ok(reply)
        ? toRenewCheck(reply.body, name, readAt())
        : null
      await deps.store.recordCall(deps.target, {
        operation: 'AdminRenewCheck',
        domainName: name,
        outcome: ok(reply)
          ? 'ok'
          : reply.status === 404
            ? 'not_found'
            : reply.status >= 500
              ? 'unknown'
              : 'rejected',
        httpStatus: reply.status,
        errorCode: ok(reply) ? null : errorCode(reply.body),
        message: data ? (data.renewable ? 'renewable' : (data.reasonKey ?? 'not_renewable')) : null,
        durationMs: Date.now() - started,
      })
      if (!data) return supplierFailure(reply)
      return { status: 'ok', data, detail: { renewable: data.renewable, years } }
    })
  })

  router.get('/supplier/prices/:tld', async (c) => {
    const tld = validTld(c.req.param('tld'))
    const op = validOp(c.req.query('op'))
    const years = validYears(c.req.query('years'))
    if (!tld || !op || years === null)
      return answer(
        c,
        refused(400, 'VALIDATION_FAILED', 'An extension, an operation and 1–10 years'),
      )
    return handle(c, 'priceCheck', adminRouteSide('priceCheck', 'live'), tld, async () => {
      const key = `${tld}:${op}:${years}`
      const cached = caches.price.get(key)
      if (cached)
        return { status: 'ok', data: cached, detail: { matches: cached.matches, cached: true } }
      const supplier = deps.catalogueSupplier()
      if (!supplier) return refused(503, 'NO_SUPPLIER_KEY', 'No catalogue key configured')
      const reply = await supplier.get(
        '/products/info',
        { ProductName: tld, OrderType: ORDER_TYPE[op], Period: years },
        LANES.normal10,
      )
      if (!ok(reply)) return supplierFailure(reply)
      const supplierCents = sellingCents(reply.body)
      if (supplierCents === null) {
        return {
          status: 'failed',
          httpStatus: 502,
          code: 'UNREADABLE',
          message: 'The price could not be read',
        }
      }
      const cost = await deps.store.tldCost(tld)
      const ourCents = cost ? ourCostCents(cost, op, years) : null
      const data: AdminPriceCheck = {
        tld,
        op,
        years,
        supplierCents,
        ourCents,
        matches: supplierCents === ourCents,
        readAt: readAt(),
      }
      caches.price.set(key, data)
      return { status: 'ok', data, detail: { supplierCents, ourCents, matches: data.matches } }
    })
  })

  function cataloguePreview(kind: 'tlds' | 'ssl') {
    const route: AdminGatewayRouteName =
      kind === 'tlds' ? 'cataloguePreview' : 'sslCataloguePreview'
    return async (c: Context<{ Variables: AdminVariables }>) =>
      handle(c, route, 'global', adminNoteTarget(route, { side: 'global' }), async () => {
        const cached = caches.preview.get(kind)
        if (cached)
          return { status: 'ok', data: cached, detail: { changes: cached.changes, cached: true } }
        const actions = kind === 'tlds' ? deps.catalogue() : deps.sslCatalogue()
        if (!actions)
          return refused(503, 'NO_SUPPLIER_KEY', 'The catalogue is not read from this gateway')
        let running = previews.get(kind)
        if (!running) {
          running = actions.preview().finally(() => previews.delete(kind))
          previews.set(kind, running)
        }
        const data = toPreview(kind, await running, readAt())
        caches.preview.set(kind, data)
        return { status: 'ok', data, detail: { outcome: data.outcome, changes: data.changes } }
      })
  }

  function catalogueApply(kind: 'tlds' | 'ssl') {
    const route: AdminGatewayRouteName = kind === 'tlds' ? 'catalogueApply' : 'sslCatalogueApply'
    return async (c: Context<{ Variables: AdminVariables }>) =>
      handle(c, route, 'global', adminNoteTarget(route, { side: 'global' }), async () => {
        if (applied.get(kind)) {
          return refused(429, 'TOO_SOON', 'The price list was applied in the last 10 minutes.')
        }
        const actions = kind === 'tlds' ? deps.catalogue() : deps.sslCatalogue()
        if (!actions)
          return refused(503, 'NOT_PRODUCTION', 'Only the production gateway applies the catalogue')
        applied.set(kind, true)
        caches.preview.clear()
        const run = await actions.apply()
        const data: AdminCatalogueApply = {
          outcome:
            run.outcome === 'written'
              ? 'applied'
              : run.outcome === 'refused'
                ? 'refused'
                : 'applied',
          reason: run.reason,
          changes: run.changes,
          readAt: readAt(),
        }
        if (run.outcome === 'refused') {
          return { status: 'ok', data, detail: { outcome: 'refused', changes: run.changes } }
        }
        return { status: 'ok', data, detail: { outcome: run.outcome, changes: run.changes } }
      })
  }

  router.get('/supplier/catalogue/preview', cataloguePreview('tlds'))
  router.get('/supplier/ssl-catalogue/preview', cataloguePreview('ssl'))
  router.post('/supplier/catalogue/apply', catalogueApply('tlds'))
  router.post('/supplier/ssl-catalogue/apply', catalogueApply('ssl'))

  router.get('/supplier/ssl/:name', async (c) => {
    const at = sideOf(c)
    if ('error' in at) return answer(c, at.error)
    const name = validName(c.req.param('name'), true)
    if (!name) return answer(c, refused(400, 'VALIDATION_FAILED', 'Not a certificate name'))
    return handle(c, 'sslLookup', at.side, name, async () => {
      const soon = throttled(`ssl:${at.side}:${name}`)
      if (soon) return soon
      const ssl = deps.ssl()
      if (!ssl) return refused(503, 'WRITES_OFF', 'This gateway reads no side')
      const status = await ssl.status(name)
      if (status.kind === 'not_found') {
        const data: AdminSslStatus = {
          name,
          outcome: 'not_found',
          status: null,
          isConfigured: null,
          isIssued: null,
          certificateExpiresAt: null,
          subscriptionEndsAt: null,
          validUntil: null,
          readAt: readAt(),
        }
        return { status: 'ok', data, detail: { found: false } }
      }
      if (status.kind !== 'found') {
        return {
          status: 'failed',
          httpStatus: 502,
          code: status.kind === 'blocked' ? status.code : 'SUPPLIER_UNAVAILABLE',
          message: mapSupplierError('UNKNOWN').message,
        }
      }
      // GET /ssls/certificate refuses a `*.` name: wildcards have check-status only.
      const details = name.startsWith('*.') ? null : await ssl.details(name)
      const found = details?.kind === 'found' ? details.data : null
      const data: AdminSslStatus = {
        name,
        outcome: 'ok',
        status: status.data.status,
        isConfigured: status.data.isConfigured,
        isIssued: status.data.isIssued,
        certificateExpiresAt: status.data.certificateExpiresAt,
        subscriptionEndsAt: found?.subscriptionEndsAt ?? null,
        validUntil: found?.validUntil ?? null,
        readAt: readAt(),
      }
      return { status: 'ok', data, detail: { found: true, issued: data.isIssued } }
    })
  })

  router.get('/flutterwave/refunds/:flwRefundId', async (c) => {
    const at = sideOf(c)
    if ('error' in at) return answer(c, at.error)
    const flwRefundId = validFlwRefundId(c.req.param('flwRefundId'))
    const refundText = c.req.query('refund')
    const incidentText = c.req.query('incident')
    const targetType =
      refundText !== undefined ? 'refund' : incidentText !== undefined ? 'incident' : null
    const targetId =
      targetType === 'refund'
        ? validId(refundText, 'uuid')
        : targetType === 'incident'
          ? validId(incidentText, 'bigint')
          : null
    if (
      !flwRefundId ||
      !targetType ||
      !targetId ||
      (refundText !== undefined && incidentText !== undefined)
    ) {
      return answer(
        c,
        refused(400, 'VALIDATION_FAILED', 'A Flutterwave refund id and one refund or incident'),
      )
    }
    return handle(
      c,
      'flwRefundCheck',
      at.side,
      flwRefundId,
      async (note) => {
        // D23: the check is evidence for the refund or incident the admin
        // noted. The query string only says which one the web expects.
        const noted = flwTarget(note.detail)
        if (!noted || noted.type !== targetType || noted.id !== targetId) {
          return refused(403, 'TARGET_MISMATCH', 'The audit note names another refund or incident')
        }
        const flutterwave = deps.flutterwave()
        if (!flutterwave) return refused(503, 'WRITES_OFF', 'No Flutterwave key on this gateway')
        const read = await flutterwave.getRefund(flwRefundId)
        if (read.kind === 'rejected') {
          return refused(404, 'FLW_REFUND_NOT_FOUND', 'Flutterwave has no refund with that id', {
            found: false,
          })
        }
        if (read.kind === 'unknown') {
          return {
            status: 'failed',
            httpStatus: 503,
            code: 'FLW_UNAVAILABLE',
            message: 'Flutterwave did not answer. Try again shortly.',
          }
        }
        const refund = read.data
        const state = refundState(refund)
        const checkId = await deps.store.recordFlwCheck({
          auditId: c.get('adminCaller').auditId,
          testMode: at.side === 'test',
          targetType: noted.type,
          targetId: noted.id,
          flwRefundId,
          transactionId: refund.transactionId,
          amountKobo: refund.amountKobo,
          status: refund.status,
          disburseStatus: refund.disburseStatus,
          state,
        })
        const data: AdminFlwRefundCheck = {
          checkId,
          flwRefundId,
          transactionId: refund.transactionId,
          amountKobo: refund.amountKobo,
          status: refund.status.slice(0, 60),
          state,
          readAt: readAt(),
        }
        return { status: 'ok', data, detail: { checkId, state, amountKobo: refund.amountKobo } }
      },
      deps.flwBucket,
    )
  })

  router.post('/presets/drafts/:id/check', async (c) => {
    const id = validId(c.req.param('id'), 'uuid')
    if (!id) return answer(c, refused(400, 'VALIDATION_FAILED', 'Not a draft id'))
    return handle(c, 'presetDraftCheck', 'global', id, async () => {
      if (draftChecks.get(id))
        return refused(429, 'TOO_SOON', 'This draft was checked in the last minute.')
      const draft = await deps.store.draft(id)
      if (!draft) return refused(404, 'DRAFT_NOT_DUE', 'No open draft with nameservers to check')
      draftChecks.set(id, true)
      const data = await deps.checkDraft(draft)
      return { status: 'ok', data, detail: { ok: data.ok, hosts: data.hosts.length } }
    })
  })

  return router
}

/** A shared default allowance for the admin routes (§4.1). */
export const adminBucket = () => new TokenBucket(20, 0.5)
