import { type ListParams, type ListSpec, listHref, parseListParams } from './list-params'
import type { Tone } from './tone'

/**
 * The provisioning calls the gateway recorded (`supplier_calls`, I7;
 * docs/ADMIN-SPEC.md §5.2 B6): its URL (`?status=&op=&job=&from=&to=…`) and
 * words. Searches are never recorded there (FR-S7), and no domain name goes
 * in this page's address — filters are outcomes, operations and ids (N13).
 */

export const CALL_OUTCOMES = ['ok', 'not_found', 'rejected', 'blocked', 'unknown'] as const
export type CallOutcome = (typeof CALL_OUTCOMES)[number]

export const CALL_OUTCOME_LABEL: Record<CallOutcome, string> = {
  ok: 'Answered',
  not_found: 'Not found',
  rejected: 'Refused',
  blocked: 'Blocked',
  unknown: 'Unknown outcome',
}

/** An unknown outcome is not a failure — a write that timed out is settled by reading (N3). */
export const CALL_OUTCOME_TONE: Record<CallOutcome, Tone> = {
  ok: 'ok',
  not_found: 'neutral',
  rejected: 'warning',
  blocked: 'danger',
  unknown: 'warning',
}

/** What each operation the gateway records does, in words; the name shows beside it. */
export const OPERATION_LABEL: Readonly<Record<string, string>> = {
  RegisterWithContactInfo: 'Register',
  Renew: 'Renew',
  Transfer: 'Transfer in',
  CheckTransfer: 'Check a transfer',
  ModifyNameServer: 'Change nameservers',
  GetDetails: 'Read a domain',
  GetList: 'Read the listing',
  GetAuthCode: 'Read a transfer code',
  SslInitialize: 'Order a certificate',
  SslGenerateCsr: 'Generate a CSR',
  SslConfigure: 'Set up a certificate',
  SslReissue: 'Reissue a certificate',
  AdminGetDetails: 'Admin: read a domain',
  AdminTransferQuery: 'Admin: read a transfer',
  AdminRenewCheck: 'Admin: check renewal',
  AdminSslCheckStatus: 'Admin: certificate status',
  AdminSslGetCertificate: 'Admin: read a certificate',
}

/** The operations the filter offers: the ones the gateway records. */
export const CALL_OPERATIONS = Object.keys(OPERATION_LABEL)

export const CALL_SORTS = ['created', 'duration'] as const
export type CallSort = (typeof CALL_SORTS)[number]

export const CALL_SORT_COLUMN: Record<CallSort, 'created_at' | 'duration_ms'> = {
  created: 'created_at',
  duration: 'duration_ms',
}

export const CALLS_LIST: ListSpec<CallSort, CallOutcome> = {
  sorts: CALL_SORTS,
  defaultSort: 'created',
  statuses: CALL_OUTCOMES,
  perOptions: [25, 50, 100],
  defaultPer: 50,
}

export const CALLS_BASE = '/admin/supplier/calls'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type CallsSearch = ListParams<CallSort, CallOutcome> & {
  op: string | null
  /** A job's calls, from its page: a uuid, lower-cased. */
  job: string | null
}

type Search = Record<string, string | string[] | undefined>

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

export function parseCallsSearch(search: Search): CallsSearch {
  const params = parseListParams(search, CALLS_LIST)
  const op = one(search.op)
  const job = one(search.job)
  return {
    ...params,
    op: op && CALL_OPERATIONS.includes(op) ? op : null,
    job: job && UUID.test(job) ? job.toLowerCase() : null,
  }
}

export function callsHref(
  params: CallsSearch,
  changes: Partial<ListParams<CallSort, CallOutcome>> & {
    op?: string | null
    job?: string | null
  } = {},
): string {
  const { op, job, ...rest } = changes
  const reset = op !== undefined || job !== undefined
  return listHref(CALLS_BASE, params, CALLS_LIST, {
    ...rest,
    ...(reset ? { page: 1 } : {}),
    extra: { op: op === undefined ? params.op : op, job: job === undefined ? params.job : job },
  })
}

export function operationLabel(operation: string): string {
  return OPERATION_LABEL[operation] ?? operation
}

/** "820 ms", "2.4 s". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

/** The default range for the summary: the last 7 Lagos days, today included. */
export function defaultSummaryRange(now: Date): { from: string; to: string } {
  const lagos = new Date(now.getTime() + 60 * 60 * 1000)
  const to = lagos.toISOString().slice(0, 10)
  lagos.setUTCDate(lagos.getUTCDate() - 6)
  return { from: lagos.toISOString().slice(0, 10), to }
}
