import { vi } from 'vitest'
import type { JsonResponse } from '../lib/http'
import { TokenBucket } from '../lib/rate-limit'
import type { AdminRouterDeps } from './routes'
import type { AdminSupplier, AllowedGet, AllowedPostRead, Lane, ParamValue } from './supplier'

/**
 * Fakes for the admin router's boundaries: the notes, the store and the
 * supplier. Every supplier request is kept, so a test can say exactly what
 * was asked, in which lane — or that nothing was.
 */

export const ADMIN_SECRET = 'a'.repeat(40)
export const GATEWAY_SECRET = process.env.GATEWAY_SHARED_SECRET as string

export type SupplierCall = {
  method: 'GET' | 'POST'
  path: string
  params?: Readonly<Record<string, ParamValue>>
  body?: unknown
  lane: Lane
}

export function fakeSupplier(
  answers: Partial<
    Record<AllowedGet | AllowedPostRead, JsonResponse | ((call: SupplierCall) => JsonResponse)>
  >,
  environment: 'ote' | 'production' = 'ote',
) {
  const calls: SupplierCall[] = []
  const reply = (call: SupplierCall) => {
    const answer = answers[call.path as AllowedGet]
    if (!answer) throw new Error(`no fake answer for ${call.path}`)
    return typeof answer === 'function' ? answer(call) : answer
  }
  const supplier: AdminSupplier = {
    environment,
    async get(path, params, lane) {
      const call: SupplierCall = { method: 'GET', path, params, lane }
      calls.push(call)
      return reply(call)
    },
    async postRead(path, body, lane) {
      const call: SupplierCall = { method: 'POST', path, body, lane }
      calls.push(call)
      return reply(call)
    },
  }
  return { supplier, calls }
}

export function fakeDeps(overrides: Partial<AdminRouterDeps> = {}) {
  const claims: unknown[][] = []
  const results: unknown[][] = []
  const recordedCalls: unknown[] = []
  const flwChecks: unknown[] = []
  /** What the claimed note's detail holds; a test fills it for a route that reads it. */
  const noteDetail: Record<string, unknown> = {}
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const deps: AdminRouterDeps = {
    secret: ADMIN_SECRET,
    target: 'ote',
    notes: {
      claim: vi.fn(async (...args: unknown[]) => {
        claims.push(args)
        return { ok: true as const, detail: { ...noteDetail } }
      }),
      result: vi.fn(async (...args: unknown[]) => {
        results.push(args)
      }),
    },
    store: {
      recordCall: vi.fn(async (_environment, call) => {
        recordedCalls.push(call)
      }),
      recordFlwCheck: vi.fn(async (facts) => {
        flwChecks.push(facts)
        return 77
      }),
      tldCost: vi.fn(async () => ({
        registerUsd: 11.31,
        renewUsd: 11.51,
        transferUsd: 10.61,
        restoreUsd: null,
        firstTermYears: 1,
      })),
      draft: vi.fn(async () => null),
    },
    targetSupplier: () => null,
    catalogueSupplier: () => null,
    lookup: () => null,
    ssl: () => null,
    flutterwave: () => null,
    catalogue: () => null,
    sslCatalogue: () => null,
    checkDraft: vi.fn(async () => ({ ok: true, hosts: [], checkedAt: '2026-10-02T12:00:00.000Z' })),
    bucket: new TokenBucket(100, 100),
    flwBucket: new TokenBucket(100, 100),
    now: () => new Date('2026-10-02T12:00:00.000Z'),
    log,
    ...overrides,
  }
  return { deps, claims, results, recordedCalls, flwChecks, noteDetail, log }
}

export const adminHeaders = (auditId = '41', label = 'owner') => ({
  authorization: `Bearer ${GATEWAY_SECRET}`,
  'x-admin-secret': ADMIN_SECRET,
  'x-admin-audit-id': auditId,
  'x-admin-label': label,
})
