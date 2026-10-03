import { parseListParams, type SortDir, validDate } from '@/features/admin/lib/list-params'

/**
 * The emails page's URL (docs/ADMIN-SPEC.md §5.2, B11): two tabs, the
 * outbox (the default) and the compliance notices (`?tab=compliance`),
 * each with its own filters, sort and page. Parsing is strict — an unknown
 * value falls back to the unfiltered list (§9's link contract) — and links
 * are rebuilt from the parsed values, never by appending to the raw query.
 *
 * Other pages link here with `?status=failed` (the overview, §9),
 * `?status=unconfirmed`, `?status=complained`, `?status=pending` and
 * `?tab=compliance` (`adminHrefForAlertKey`, §4.5). Nothing here takes an
 * address: recipients are only ever shown masked, and never searched (N13).
 */

export const EMAILS_PATH = '/admin/emails'

export const EMAIL_TABS = ['outbox', 'compliance'] as const
export type EmailTab = (typeof EMAIL_TABS)[number]

/**
 * One status at a time. The outbox's own five, and three views of what
 * became of a sent email: `bounced`, `unconfirmed` (a security or
 * compliance email with no delivery report a day after sending — the
 * `email_unconfirmed` alert) and `complained` (reported as spam).
 */
export const OUTBOX_STATUSES = [
  'failed',
  'pending',
  'sending',
  'sent',
  'skipped',
  'bounced',
  'unconfirmed',
  'complained',
] as const
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number]

export const EMAIL_CATEGORIES = ['transactional', 'security', 'compliance'] as const
export type EmailCategory = (typeof EMAIL_CATEGORIES)[number]

export const OUTBOX_SORTS = ['created', 'sent'] as const
export type OutboxSort = (typeof OUTBOX_SORTS)[number]

/** A notice's delivery as `compliance_notices` records it; `sent` is "no report yet". */
export const NOTICE_STATUSES = ['bounced', 'sent', 'delivered'] as const
export type NoticeStatus = (typeof NOTICE_STATUSES)[number]

export const NOTICE_TYPES = ['errp_pre_35', 'errp_pre_7', 'errp_post'] as const
export type NoticeType = (typeof NOTICE_TYPES)[number]

export const NOTICE_SORTS = ['sent', 'expires'] as const
export type NoticeSort = (typeof NOTICE_SORTS)[number]

export const PER_OPTIONS = [25, 50, 100] as const
const DEFAULT_PER = 25

/** An email kind as the outbox stores it (`^[a-z_]+$`). */
const KIND = /^[a-z_]{1,40}$/

type Paging<S extends string> = {
  sort: S
  dir: SortDir
  page: number
  per: number
  from: string | null
  to: string | null
}

export type OutboxParams = Paging<OutboxSort> & {
  tab: 'outbox'
  status: OutboxStatus | null
  category: EmailCategory | null
  kind: string | null
}

export type NoticeParams = Paging<NoticeSort> & {
  tab: 'compliance'
  status: NoticeStatus | null
  type: NoticeType | null
}

export type EmailsParams = OutboxParams | NoticeParams

type Search = Record<string, string | string[] | undefined> | URLSearchParams

function first(search: Search, key: string): string | undefined {
  if (search instanceof URLSearchParams) return search.get(key) ?? undefined
  const value = search[key]
  return Array.isArray(value) ? value[0] : value
}

/** The first value of a comma list that is one of `known`; anything else is none. */
function oneOf<T extends string>(value: string | undefined, known: readonly T[]): T | null {
  for (const part of (value ?? '').split(',')) {
    const trimmed = part.trim()
    if ((known as readonly string[]).includes(trimmed)) return trimmed as T
  }
  return null
}

export function parseEmailTab(value: string | undefined): EmailTab {
  return value === 'compliance' ? 'compliance' : 'outbox'
}

export function parseEmailsParams(search: Search): EmailsParams {
  const tab = parseEmailTab(first(search, 'tab'))
  if (tab === 'compliance') {
    const list = parseListParams(search, {
      sorts: NOTICE_SORTS,
      defaultSort: 'sent',
      perOptions: PER_OPTIONS,
      defaultPer: DEFAULT_PER,
    })
    return {
      tab,
      status: oneOf(first(search, 'status'), NOTICE_STATUSES),
      type: oneOf(first(search, 'type'), NOTICE_TYPES),
      sort: list.sort,
      dir: list.dir,
      page: list.page,
      per: list.per,
      from: list.from,
      to: list.to,
    }
  }
  const list = parseListParams(search, {
    sorts: OUTBOX_SORTS,
    defaultSort: 'created',
    perOptions: PER_OPTIONS,
    defaultPer: DEFAULT_PER,
  })
  const kind = (first(search, 'kind') ?? '').trim()
  return {
    tab,
    status: oneOf(first(search, 'status'), OUTBOX_STATUSES),
    category: oneOf(first(search, 'category'), EMAIL_CATEGORIES),
    kind: KIND.test(kind) ? kind : null,
    sort: list.sort,
    dir: list.dir,
    page: list.page,
    per: list.per,
    from: list.from,
    to: list.to,
  }
}

/** The default sort of a tab: newest first. */
const DEFAULT_SORT: Record<EmailTab, string> = { outbox: 'created', compliance: 'sent' }

type Changes<P extends EmailsParams> = Partial<Omit<P, 'tab'>>

/**
 * The same list with some values changed. Defaults stay out of the URL, and
 * changing a filter, the sort or the page size goes back to page 1.
 */
export function emailsHref<P extends EmailsParams>(params: P, changes: Changes<P> = {}): string {
  const filtersChanged = Object.keys(changes).some((key) => key !== 'page')
  const next = {
    ...params,
    ...changes,
    page: changes.page ?? (filtersChanged ? 1 : params.page),
  } as EmailsParams
  const query = new URLSearchParams()
  if (next.tab === 'compliance') query.set('tab', 'compliance')
  if (next.status) query.set('status', next.status)
  if (next.tab === 'outbox') {
    if (next.category) query.set('category', next.category)
    if (next.kind) query.set('kind', next.kind)
  } else if (next.type) {
    query.set('type', next.type)
  }
  const from = validDate(next.from ?? undefined)
  const to = validDate(next.to ?? undefined)
  if (from) query.set('from', from)
  if (to) query.set('to', to)
  if (next.sort !== DEFAULT_SORT[next.tab]) query.set('sort', next.sort)
  if (next.dir !== 'desc') query.set('dir', next.dir)
  if (next.per !== DEFAULT_PER) query.set('per', String(next.per))
  if (next.page > 1) query.set('page', String(next.page))
  const text = query.toString()
  return text ? `${EMAILS_PATH}?${text}` : EMAILS_PATH
}

/** A tab's own address: the outbox is the page itself. */
export function emailsTabHref(tab: EmailTab): string {
  return tab === 'outbox' ? EMAILS_PATH : `${EMAILS_PATH}?tab=compliance`
}

/** A chip's link: choosing the chosen one again shows them all. */
export function chosen<T extends string>(current: T | null, value: T): T | null {
  return current === value ? null : value
}

/** True when the list is narrowed by anything but its sort and page. */
export function isEmailsFiltered(params: EmailsParams): boolean {
  if (params.status || params.from || params.to) return true
  return params.tab === 'outbox' ? Boolean(params.category || params.kind) : Boolean(params.type)
}

/** The start of a Lagos day (WAT, UTC+1, no daylight saving), for `created_at >=`. */
export function watDayStart(day: string): string {
  return `${day}T00:00:00+01:00`
}

/** The start of the Lagos day after, for `created_at <`. */
export function watDayEnd(day: string): string {
  const next = new Date(`${day}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return `${next.toISOString().slice(0, 10)}T00:00:00+01:00`
}
