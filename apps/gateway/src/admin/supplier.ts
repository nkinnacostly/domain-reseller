import type { WriteTarget } from '../dna/client'
import { type JsonResponse, requestJson } from '../lib/http'
import type { Priority } from '../lib/semaphore'

/**
 * The only way the admin routes reach DomainNameAPI (docs/ADMIN-SPEC.md
 * §4.2, D11): GET reads on a fixed list of paths, and two POST reads. No
 * write exists here — no registration, renewal, transfer, nameserver,
 * contact or certificate call — and nothing can be added by a caller:
 * query strings are built only from each path's allowlisted parameter
 * names, POST bodies only from a domain name and a period, and the
 * reseller's own filters (`ResellerId`, `ResellerNames`) are never sent.
 */

export const SUPPLIER_BASE_URL: Record<WriteTarget, string> = {
  production: 'https://api.domainresellerapi.com/api/v1',
  ote: 'https://ote.domainresellerapi.com/api/v1',
}

export const ALLOWED_GET = [
  '/deposit/accounts/me',
  '/deposit/transactions',
  '/domains',
  '/contacts/verification/check',
  '/products/info',
  '/products/tlds',
  '/products/ssls',
] as const

export const ALLOWED_POST_READ = ['/domains/transfers/query', '/domains/renew/check'] as const

export type AllowedGet = (typeof ALLOWED_GET)[number]
export type AllowedPostRead = (typeof ALLOWED_POST_READ)[number]

/** The parameter names each GET may carry. Anything else is refused, never dropped silently. */
export const PARAMS: Record<AllowedGet, readonly string[]> = {
  '/deposit/accounts/me': [],
  '/deposit/transactions': [
    'StartDate',
    'EndDate',
    'TransactionTypes',
    'ProductTypes',
    'FilterText',
    'TraceId',
    'Sorting',
    'SkipCount',
    'MaxResultCount',
  ],
  '/domains': ['DomainName', 'SkipCount', 'MaxResultCount'],
  '/contacts/verification/check': ['HandleCode'],
  '/products/info': ['ProductName', 'OrderType', 'Period'],
  '/products/tlds': ['SkipCount', 'MaxResultCount'],
  '/products/ssls': ['SkipCount', 'MaxResultCount'],
}

export class NotAllowed extends Error {
  constructor(what: string) {
    super(`Not allowed from the admin routes: ${what}`)
    this.name = 'NotAllowed'
  }
}

export type Lane = { priority: Exclude<Priority, 'high'>; waitMs: number }

export type ParamValue = string | number | readonly (string | number)[]

export type AdminSupplier = {
  environment: WriteTarget
  get(
    path: AllowedGet,
    params: Readonly<Record<string, ParamValue>>,
    lane: Lane,
  ): Promise<JsonResponse>
  postRead(
    path: AllowedPostRead,
    body: { domainName: string; period?: number },
    lane: Lane,
  ): Promise<JsonResponse>
}

export type AdminSupplierOptions = {
  environment: WriteTarget
  apiKey: string
  resellerId: string
  /** The supplier slots: two in flight, two starts a second. Admin never asks for `high`. */
  run: <T>(task: () => Promise<T>, lane: Lane) => Promise<T>
  send?: typeof requestJson
  timeoutMs?: number
}

function isAllowedGet(path: string): path is AllowedGet {
  return (ALLOWED_GET as readonly string[]).includes(path)
}

function isAllowedPost(path: string): path is AllowedPostRead {
  return (ALLOWED_POST_READ as readonly string[]).includes(path)
}

/** A query string from allowlisted names only; a repeated name for a list. */
export function buildQuery(path: AllowedGet, params: Readonly<Record<string, ParamValue>>): string {
  const allowed = PARAMS[path]
  const query = new URLSearchParams()
  for (const [name, value] of Object.entries(params)) {
    if (!allowed.includes(name)) throw new NotAllowed(`parameter ${name} on ${path}`)
    const values = Array.isArray(value) ? value : [value]
    for (const item of values) query.append(name, String(item))
  }
  const text = query.toString()
  return text ? `?${text}` : ''
}

export function createAdminSupplier(options: AdminSupplierOptions): AdminSupplier {
  const { environment, apiKey, resellerId, run, send = requestJson, timeoutMs = 30_000 } = options
  const headers = { 'X-API-KEY': apiKey, __reseller: resellerId }
  const guardLane = (lane: Lane) => {
    if ((lane.priority as Priority) === 'high') throw new NotAllowed('the high lane')
  }

  return {
    environment,
    async get(path, params, lane) {
      if (!isAllowedGet(path)) throw new NotAllowed(`GET ${path}`)
      guardLane(lane)
      const url = `${SUPPLIER_BASE_URL[environment]}${path}${buildQuery(path, params)}`
      return run(() => send(url, { method: 'GET', headers, timeoutMs }), lane)
    },
    async postRead(path, body, lane) {
      if (!isAllowedPost(path)) throw new NotAllowed(`POST ${path}`)
      guardLane(lane)
      // Exactly these fields, rebuilt: nothing else a caller passes reaches the supplier.
      const payload: { domainName: string; period?: number } = {
        domainName: String(body.domainName),
      }
      if (path === '/domains/renew/check') {
        const period = body.period
        if (period === undefined || !Number.isInteger(period)) {
          throw new NotAllowed('a renew check without a period')
        }
        payload.period = period
      }
      const url = `${SUPPLIER_BASE_URL[environment]}${path}`
      return run(() => send(url, { method: 'POST', headers, body: payload, timeoutMs }), lane)
    },
  }
}
