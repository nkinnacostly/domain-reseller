import {
  type CatalogueDiff,
  compareCatalogue,
  formatReport,
  hasChanges,
  listingRefusal,
  retirementRefusal,
  termsNotes,
  toRows,
} from './catalogue'
import type { CatalogueStore } from './store'
import type { CatalogueSource } from './supplier'

/**
 * One catalogue sync, shared by the CLI (`sync:catalogue`, report unless
 * `--apply`) and the gateway's weekly schedule (always applies). Every change
 * is reported before anything is written; a listing that cannot be trusted
 * is refused and nothing is written. Supplier or database errors throw.
 */

export type SyncOutcome =
  /** Nothing to write. */
  | 'unchanged'
  /** Changes found; report only. */
  | 'changes'
  | 'written'
  /** The listing looked broken; nothing written. */
  | 'refused'

export type SyncResult = {
  outcome: SyncOutcome
  reason: string | null
  /** Extensions the supplier listed, and how many of them we can price. */
  listed: number
  sellable: number
  /** Null when the listing was refused before it could be compared. */
  diff: CatalogueDiff | null
  report: string[]
}

export type SyncOptions = {
  source: CatalogueSource
  store: CatalogueStore
  apply: boolean
  now?: () => Date
}

export async function syncCatalogue(options: SyncOptions): Promise<SyncResult> {
  const { source, store, apply, now = () => new Date() } = options

  const listing = await source()
  const rows = toRows(listing.items)
  const counts = { listed: listing.items.length, sellable: rows.length }

  const unreadable = listingRefusal(listing, rows)
  if (unreadable) {
    return { outcome: 'refused', reason: unreadable, ...counts, diff: null, report: [unreadable] }
  }

  const current = await store.load()
  const diff = compareCatalogue(rows, current)
  const report = formatReport(diff, counts.listed, counts.sellable, termsNotes(listing.items))

  const tooMany = retirementRefusal(diff, current)
  if (tooMany) {
    return {
      outcome: 'refused',
      reason: tooMany,
      ...counts,
      diff,
      report: [...report, '', `Refused: ${tooMany}. Nothing written.`],
    }
  }
  if (!hasChanges(diff)) {
    return {
      outcome: 'unchanged',
      reason: null,
      ...counts,
      diff,
      report: [...report, '', 'Catalogue is up to date.'],
    }
  }
  if (!apply) {
    return {
      outcome: 'changes',
      reason: null,
      ...counts,
      diff,
      report: [...report, '', 'Report only. Re-run with --apply to write.'],
    }
  }

  await store.upsert(rows, now().toISOString())
  if (diff.retired.length > 0) await store.retire(diff.retired)

  return {
    outcome: 'written',
    reason: null,
    ...counts,
    diff,
    report: [
      ...report,
      '',
      `Written. ${rows.length} extensions now priced from the live catalogue.`,
    ],
  }
}

/** The counts a log line or heartbeat carries: no prices, no report text. */
export function summarise(result: SyncResult) {
  return {
    listed: result.listed,
    sellable: result.sellable,
    added: result.diff?.added.length ?? 0,
    retired: result.diff?.retired.length ?? 0,
    priceChanges: result.diff?.priceChanges.length ?? 0,
    otherChanges: result.diff?.detailChanges.length ?? 0,
  }
}
