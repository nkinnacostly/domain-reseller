import { type ListParams, type ListSpec, parseListParams } from '@/features/admin/lib/list-params'

/**
 * The audit log's URL (docs/ADMIN-SPEC.md §5.2, B14): the shared
 * `?from=&to=&dir=&page=&per=`, plus
 * - `action=<prefix>` — one family of actions (`refund`, `supplier`, …);
 * - `outcome=intent,ok,refused,failed` — a comma list;
 * - `side=live|test|global` — the records an entry touched;
 * - `who=admins|test` — real or test administrators (never for a test admin);
 * - `admin=<label>` — one administrator, by label (never an email);
 * - `target=<id>` — entries about one record, by its uuid or number;
 * - `id=<n>` — one entry (`adminHref.audit`).
 *
 * Parsing is strict: anything unknown or misshapen is dropped, never sent to
 * a query. A target is an id and nothing else — a domain name in a URL is
 * shared with every admin who opens it (N13).
 */

export const AUDIT_PATH = '/admin/audit'

/** Every action family `admin_tier` knows, in the order the chips show them. */
export const AUDIT_PREFIXES = [
  'refund',
  'incident',
  'job',
  'ssl_job',
  'domain',
  'email',
  'customer',
  'supplier',
  'fx',
  'pricing',
  'settings',
  'extension',
  'ssl_product',
  'preset',
  'topup',
  'audit',
] as const
export type AuditPrefix = (typeof AUDIT_PREFIXES)[number]

export const AUDIT_OUTCOMES = ['intent', 'ok', 'refused', 'failed'] as const
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number]

export const AUDIT_SIDES = ['live', 'test', 'global'] as const
export type AuditSide = (typeof AUDIT_SIDES)[number]

export const AUDIT_WHO = ['admins', 'test'] as const
export type AuditWho = (typeof AUDIT_WHO)[number]

export type AuditSort = 'when'

export const AUDIT_SPEC: ListSpec<AuditSort> = {
  sorts: ['when'],
  defaultSort: 'when',
  defaultDir: 'desc',
  perOptions: [25, 50, 100],
  defaultPer: 50,
}

export type AuditParams = {
  list: ListParams<AuditSort>
  prefix: AuditPrefix | null
  outcome: AuditOutcome[]
  side: AuditSide | null
  who: AuditWho | null
  admin: string | null
  target: string | null
  id: number | null
}

type Search = Record<string, string | string[] | undefined> | URLSearchParams

/** An admin label as `admins.label` allows it: never an email. */
export const ADMIN_LABEL = /^[a-z][a-z0-9_-]{1,30}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** An entry number: a positive whole number JavaScript holds exactly. */
const ENTRY = /^[1-9]\d{0,14}$/
/** A record's number (an incident, a top-up). */
const NUMBER = /^[1-9]\d{0,18}$/

function first(search: Search, key: string): string | undefined {
  if (search instanceof URLSearchParams) return search.get(key) ?? undefined
  const value = search[key]
  return Array.isArray(value) ? value[0] : value
}

function oneOf<T extends string>(list: readonly T[], value: string | undefined): T | null {
  return (list as readonly string[]).includes(value ?? '') ? (value as T) : null
}

export function parseAuditLabel(value: string | undefined): string | null {
  const text = value?.trim().toLowerCase() ?? ''
  return ADMIN_LABEL.test(text) ? text : null
}

/** A uuid (lower-cased) or a record's number; a name or anything else is null. */
export function parseAuditTarget(value: string | undefined): string | null {
  const text = value?.trim() ?? ''
  if (UUID.test(text)) return text.toLowerCase()
  return NUMBER.test(text) ? text : null
}

export function parseAuditId(value: string | undefined): number | null {
  const text = value?.trim() ?? ''
  return ENTRY.test(text) ? Number(text) : null
}

export function parseAuditParams(search: Search, testOnly = false): AuditParams {
  const outcomes = new Set(
    (first(search, 'outcome') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value): value is AuditOutcome => oneOf(AUDIT_OUTCOMES, value) !== null),
  )
  return {
    list: parseListParams(search, AUDIT_SPEC),
    prefix: oneOf(AUDIT_PREFIXES, first(search, 'action')),
    // In the chips' order, so a link reads the same however it was built.
    outcome: AUDIT_OUTCOMES.filter((value) => outcomes.has(value)),
    side: oneOf(AUDIT_SIDES, first(search, 'side')),
    // A test administrator sees test administrators' entries only (D15).
    who: testOnly ? null : oneOf(AUDIT_WHO, first(search, 'who')),
    admin: parseAuditLabel(first(search, 'admin')),
    target: parseAuditTarget(first(search, 'target')),
    id: parseAuditId(first(search, 'id')),
  }
}

export type AuditChanges = Partial<Omit<AuditParams, 'list'>> & {
  page?: number
  dir?: 'asc' | 'desc'
  from?: string | null
  to?: string | null
}

/**
 * The same list with some values changed. Defaults stay out of the URL, and
 * any change but the page goes back to page 1.
 */
export function auditHref(params: AuditParams, changes: AuditChanges = {}): string {
  const { page, dir, from, to, ...filters } = changes
  const next = { ...params, ...filters }
  const list = {
    ...params.list,
    ...(dir !== undefined ? { dir } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  }
  const query = new URLSearchParams()
  if (next.prefix) query.set('action', next.prefix)
  if (next.outcome.length > 0) query.set('outcome', next.outcome.join(','))
  if (next.side) query.set('side', next.side)
  if (next.who) query.set('who', next.who)
  if (next.admin) query.set('admin', next.admin)
  if (next.target) query.set('target', next.target)
  if (next.id !== null) query.set('id', String(next.id))
  if (list.from) query.set('from', list.from)
  if (list.to) query.set('to', list.to)
  if (list.dir !== AUDIT_SPEC.defaultDir) query.set('dir', list.dir)
  if (list.per !== AUDIT_SPEC.defaultPer) query.set('per', String(list.per))
  const nextPage = page ?? (Object.keys(changes).length > 0 ? 1 : list.page)
  if (nextPage > 1) query.set('page', String(nextPage))
  const text = query.toString()
  return text ? `${AUDIT_PATH}?${text}` : AUDIT_PATH
}

/** Whether anything narrows the list (the empty state then offers to clear it). */
export function auditFiltersActive(params: AuditParams): boolean {
  return (
    params.prefix !== null ||
    params.outcome.length > 0 ||
    params.side !== null ||
    params.who !== null ||
    params.admin !== null ||
    params.target !== null ||
    params.id !== null ||
    params.list.from !== null ||
    params.list.to !== null
  )
}

/** The outcome chips toggle one at a time inside the list. */
export function toggleOutcome(params: AuditParams, outcome: AuditOutcome): string {
  const chosen = params.outcome.includes(outcome)
    ? params.outcome.filter((value) => value !== outcome)
    : [...params.outcome, outcome]
  return auditHref(params, { outcome: AUDIT_OUTCOMES.filter((value) => chosen.includes(value)) })
}

/** The first moment of a Lagos day (WAT, UTC+1, no daylight saving). */
export function watDayStart(day: string): string {
  return `${day}T00:00:00+01:00`
}

/** The first moment of the Lagos day after `day`: the range's open end. */
export function watDayEnd(day: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return `${date.toISOString().slice(0, 10)}T00:00:00+01:00`
}
