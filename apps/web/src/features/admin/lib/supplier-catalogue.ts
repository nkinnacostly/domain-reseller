import type { AdminCatalogueApply, AdminCataloguePreview } from '@dr/shared/admin'
import { formatCount } from './format'
import type { Tone } from './tone'

/**
 * The price list page (docs/ADMIN-SPEC.md §5.2 B6, D19): what a preview of
 * the weekly catalogue sync found, and what an apply did. The report is the
 * sync's own (`formatReport` in the gateway, at most 200 lines): plain text
 * in blocks split by blank lines, shown as it is written — a summary line
 * first, then each block.
 */

export type CatalogueKind = AdminCataloguePreview['kind']

export const CATALOGUE_NAME: Record<CatalogueKind, string> = {
  tlds: 'Domain extensions',
  ssl: 'SSL products',
}

const THING: Record<CatalogueKind, { one: string; many: string }> = {
  tlds: { one: 'extension', many: 'extensions' },
  ssl: { one: 'product', many: 'products' },
}

const plural = (count: number, one: string, many: string) =>
  `${formatCount(count)} ${count === 1 ? one : many}`

export type PreviewSummary = { tone: Tone; headline: string; counts: string }

/** The preview in one line, and its counts. */
export function previewSummary(preview: AdminCataloguePreview): PreviewSummary {
  const thing = THING[preview.kind]
  const counts = `${plural(preview.listed, thing.one, thing.many)} listed · ${formatCount(preview.sellable)} sellable · ${plural(preview.changes, 'change', 'changes')}`
  if (preview.outcome === 'refused') {
    return {
      tone: 'warning',
      headline: `The sync would refuse this listing${preview.reason ? `: ${preview.reason}` : ''}. Applying writes nothing until it looks right.`,
      counts,
    }
  }
  if (preview.outcome === 'failed') {
    return {
      tone: 'danger',
      headline: `DomainNameAPI's listing couldn't be read${preview.reason ? `: ${preview.reason}` : ''}. Try again later.`,
      counts,
    }
  }
  if (preview.changes === 0) {
    return { tone: 'ok', headline: 'Up to date: applying now would change nothing.', counts }
  }
  return {
    tone: 'info',
    headline: `${plural(preview.changes, 'change', 'changes')} waiting. The weekly sync writes ${preview.changes === 1 ? 'it' : 'them'}, or apply now.`,
    counts,
  }
}

export type ReportBlock = { lead: string; lines: string[] }

/**
 * The report's blocks, split at blank lines. Each block's first line leads;
 * the rest keep their own indentation removed, so a phone shows them without
 * a sideways scroll of spaces. Nothing is reworded or dropped.
 */
export function reportBlocks(report: readonly string[]): ReportBlock[] {
  const blocks: ReportBlock[] = []
  let current: string[] = []
  const flush = () => {
    const [lead, ...lines] = current
    if (lead !== undefined) blocks.push({ lead: lead.trim(), lines: lines.map((l) => l.trim()) })
    current = []
  }
  for (const line of report) {
    if (line.trim() === '') flush()
    else current.push(line)
  }
  flush()
  return blocks
}

/** What an apply did, in words, and how it looks. */
export function applySummary(apply: AdminCatalogueApply): { ok: boolean; words: string } {
  if (apply.outcome === 'refused') {
    return {
      ok: false,
      words: `The sync refused the listing, so nothing was written${apply.reason ? `: ${apply.reason}` : ''}.`,
    }
  }
  if (apply.outcome === 'failed') {
    return {
      ok: false,
      words: `The sync failed part-way${apply.reason ? `: ${apply.reason}` : ''}. Preview again to see what was written.`,
    }
  }
  if (apply.changes === 0) return { ok: true, words: 'Applied: nothing needed changing.' }
  return {
    ok: true,
    words: `Applied ${plural(apply.changes, 'change', 'changes')}. Site prices update on the next refresh.`,
  }
}

export type SyncHeartbeat = { beatAt: string; outcome: string | null; changes: number | null }

/** The weekly sync's last run, from its heartbeat's detail: no prices, counts only. */
export function heartbeatFrom(
  row: { beat_at: string; detail: unknown } | null,
): SyncHeartbeat | null {
  if (!row) return null
  const detail =
    typeof row.detail === 'object' && row.detail !== null && !Array.isArray(row.detail)
      ? (row.detail as Record<string, unknown>)
      : {}
  const count = (key: string) => (typeof detail[key] === 'number' ? (detail[key] as number) : 0)
  const changes =
    count('added') + count('retired') + count('priceChanges') + count('otherChanges') || null
  return {
    beatAt: row.beat_at,
    outcome: typeof detail.outcome === 'string' ? detail.outcome : null,
    changes,
  }
}

const OUTCOME_WORDS: Readonly<Record<string, string>> = {
  written: 'wrote its changes',
  unchanged: 'found nothing to change',
  refused: 'refused the listing',
  failed: 'failed',
}

/** "Last weekly sync: 1 Oct 2026, 13:03 WAT — wrote its changes (3)". */
export function heartbeatWords(beat: SyncHeartbeat, when: string): string {
  const outcome = beat.outcome
    ? (OUTCOME_WORDS[beat.outcome] ?? beat.outcome.replace(/_/g, ' '))
    : 'ran'
  const changes =
    beat.changes !== null && beat.outcome === 'written'
      ? ` (${plural(beat.changes, 'change', 'changes')})`
      : ''
  return `Last sync ${when}: ${outcome}${changes}.`
}
