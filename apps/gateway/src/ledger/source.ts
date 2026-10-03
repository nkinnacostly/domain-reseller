import type { AdminSupplier, Lane } from '../admin/supplier'
import { LedgerReadError, type LedgerRow, toLedgerRow } from './normalize'

/**
 * Reads the supplier's statement since a moment (docs/ADMIN-SPEC.md §4.4).
 *
 * `deposit/transactions` ignores `StartDate` unless `EndDate` comes with it,
 * and with both it filters by whole UTC+3 days (seen 2 Oct 2026). So every
 * request carries both — from the day before `since` to tomorrow — and the
 * rows are filtered back in UTC. A read is complete or it is nothing: the
 * rows read must equal the supplier's `totalCount`, or the read is refused
 * and the mirror records nothing (I2's spirit: a partial statement is not a
 * statement).
 */

export const LEDGER_PAGE_SIZE = 200
export const LEDGER_MAX_PAGES = 50
const DAY_MS = 86_400_000
/** The supplier's calendar: UTC+3 all year. */
const SUPPLIER_OFFSET_MS = 3 * 3_600_000

/** A UTC+3 date (`YYYY-MM-DD`) for an instant. */
export function supplierDay(at: number): string {
  return new Date(at + SUPPLIER_OFFSET_MS).toISOString().slice(0, 10)
}

export type LedgerRead = { rows: LedgerRow[]; read: number; readAt: string }
export type LedgerSource = (since: Date) => Promise<LedgerRead>

export function createLedgerSource(options: {
  supplier: AdminSupplier
  now?: () => Date
  pageSize?: number
  maxPages?: number
  /** Behind everything a person waits for, in the two supplier slots. */
  lane?: Lane
}): LedgerSource {
  const {
    supplier,
    now = () => new Date(),
    pageSize = LEDGER_PAGE_SIZE,
    maxPages = LEDGER_MAX_PAGES,
    lane = { priority: 'low', waitMs: 60_000 },
  } = options

  return async function readSince(since) {
    const startedAt = now()
    const from = since.getTime() - DAY_MS
    const params = {
      StartDate: supplierDay(from),
      EndDate: supplierDay(startedAt.getTime() + DAY_MS),
      Sorting: 'creationTime asc',
    }

    const items: unknown[] = []
    let total: number | null = null
    let complete = false
    for (let page = 0; page < maxPages; page += 1) {
      const answer = await supplier.get(
        '/deposit/transactions',
        { ...params, SkipCount: page * pageSize, MaxResultCount: pageSize },
        lane,
      )
      if (answer.status < 200 || answer.status >= 300) {
        throw new LedgerReadError(`The ledger page answered HTTP ${answer.status}`)
      }
      const body = (answer.body ?? {}) as { items?: unknown; totalCount?: unknown }
      if (!Array.isArray(body.items)) throw new LedgerReadError('The ledger page was not a listing')
      if (typeof body.totalCount === 'number' && Number.isInteger(body.totalCount)) {
        total = body.totalCount
      }
      items.push(...body.items)
      if (body.items.length < pageSize) {
        complete = true
        break
      }
    }
    if (!complete)
      throw new LedgerReadError(`The ledger ran past ${maxPages} pages; stopped reading`)
    if (total === null || items.length !== total) {
      throw new LedgerReadError(
        `Read ${items.length} of ${total ?? 'an unknown number of'} ledger entries`,
      )
    }

    const rows = items.map(toLedgerRow).filter((row) => Date.parse(row.occurredAt) >= from)
    // Overlapping pages or days: one row per trace.
    const unique = [...new Map(rows.map((row) => [row.traceId, row])).values()]
    return { rows: unique, read: items.length, readAt: startedAt.toISOString() }
  }
}
