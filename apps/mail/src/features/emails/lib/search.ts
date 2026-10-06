import {
  type Cursor,
  decodeCursor,
  EMAIL_STATUSES,
  type EmailFilters,
  type EmailStatus,
  encodeCursor,
} from '@dr/shared/mail'
import { z } from 'zod'
import { lagosDayEnd, lagosDayStart } from './format'

/**
 * The log's search (MAIL-SPEC §10 Emails): by id, exact recipient, subject,
 * tag, status and date — the address's query string, read and checked here,
 * then answered by SQL (`account_emails`, migration 48). A field that is not
 * valid is said so by name, and nothing is searched until it is fixed.
 */

export const SEARCH_FIELDS = ['id', 'to', 'subject', 'tag', 'status', 'since', 'until'] as const
export type SearchField = (typeof SEARCH_FIELDS)[number]

export type LogSearch = {
  /** What the form shows: what was asked, as it was typed. */
  values: Record<SearchField, string>
  filters: EmailFilters
  errors: Partial<Record<SearchField, string>>
  cursor: Cursor | null
  isFiltered: boolean
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
/** A real calendar day: `2026-02-30` is refused, not rolled into March. */
function isDay(value: string): boolean {
  if (!DAY.test(value)) return false
  const at = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value
}

const CHECKS: Record<SearchField, (value: string) => string | null> = {
  id: (value) =>
    z.uuid().safeParse(value).success
      ? null
      : 'Not an email id: ids look like 6f1d3a52-2a0e-4f0b-…',
  to: (value) => (z.email().safeParse(value).success ? null : 'Enter one whole email address'),
  subject: (value) => (value.length <= 200 ? null : 'At most 200 characters'),
  tag: (value) =>
    /^[A-Za-z0-9_-]{1,256}(:[A-Za-z0-9_-]{1,256})?$/.test(value)
      ? null
      : 'A tag name, or name:value (letters, digits, _ and -)',
  status: (value) =>
    (EMAIL_STATUSES as readonly string[]).includes(value) ? null : 'Choose a status from the list',
  since: (value) => (isDay(value) ? null : 'A date, like 2026-10-06'),
  until: (value) => (isDay(value) ? null : 'A date, like 2026-10-06'),
}

const first = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value)?.trim() ?? ''

export function readSearch(params: Record<string, string | string[] | undefined>): LogSearch {
  const values = Object.fromEntries(
    SEARCH_FIELDS.map((field) => [field, first(params[field])]),
  ) as Record<SearchField, string>
  const errors: LogSearch['errors'] = {}
  for (const field of SEARCH_FIELDS) {
    const value = values[field]
    const problem = value ? CHECKS[field](value) : null
    if (problem) errors[field] = problem
  }
  if (
    !errors.since &&
    !errors.until &&
    values.since &&
    values.until &&
    values.until < values.since
  ) {
    errors.until = 'The last day comes on or after the first'
  }

  const filters: EmailFilters = {}
  if (values.id && !errors.id) filters.id = values.id.toLowerCase()
  if (values.to && !errors.to) filters.to = values.to.toLowerCase()
  if (values.subject && !errors.subject) filters.subject = values.subject
  if (values.tag && !errors.tag) filters.tag = values.tag
  if (values.status && !errors.status) filters.status = values.status as EmailStatus
  if (values.since && !errors.since) filters.createdAfter = lagosDayStart(values.since)
  if (values.until && !errors.until) filters.createdBefore = lagosDayEnd(values.until)

  const rawCursor = first(params.cursor)
  return {
    values,
    filters,
    errors,
    cursor: rawCursor ? decodeCursor(rawCursor) : null,
    isFiltered: SEARCH_FIELDS.some((field) => values[field] !== ''),
  }
}

/** The log's address for this search, at a page (`cursor`) or from the newest. */
export function searchHref(values: Record<SearchField, string>, cursor?: Cursor): string {
  const params = new URLSearchParams()
  for (const field of SEARCH_FIELDS) if (values[field]) params.set(field, values[field])
  if (cursor) params.set('cursor', encodeCursor(cursor))
  const query = params.toString()
  return query ? `/dashboard/emails?${query}` : '/dashboard/emails'
}
