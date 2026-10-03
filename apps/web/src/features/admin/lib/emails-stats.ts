import { NOTICE_TYPES, type NoticeType } from '@/features/admin/lib/emails-params'

/**
 * The emails page's figures, from `admin_email_stats` (docs/ADMIN-SPEC.md
 * §3.2h): counts by kind, category, status and delivery for the outbox, and
 * by notice type and delivery for the compliance log, over a window. Pure:
 * the query parses the answer, these add it up.
 */

export type KindStat = {
  kind: string
  category: string
  status: string
  deliveryStatus: string | null
  count: number
}

export type NoticeStat = { noticeType: string; deliveryStatus: string | null; count: number }

export type OutboxTotals = {
  total: number
  failed: number
  /** Waiting or being sent now. */
  waiting: number
  /** Accepted by the provider: delivered, bounced or not yet reported. */
  sent: number
  delivered: number
  bounced: number
  skipped: number
}

export function outboxTotals(rows: readonly KindStat[]): OutboxTotals {
  const totals: OutboxTotals = {
    total: 0,
    failed: 0,
    waiting: 0,
    sent: 0,
    delivered: 0,
    bounced: 0,
    skipped: 0,
  }
  for (const row of rows) {
    totals.total += row.count
    if (row.status === 'failed') totals.failed += row.count
    else if (row.status === 'pending' || row.status === 'sending') totals.waiting += row.count
    else if (row.status === 'skipped') totals.skipped += row.count
    else if (row.status === 'sent') {
      totals.sent += row.count
      if (row.deliveryStatus === 'delivered') totals.delivered += row.count
      if (row.deliveryStatus === 'bounced') totals.bounced += row.count
    }
  }
  return totals
}

export type KindRow = OutboxTotals & { kind: string; category: string }

/** One row per kind, the busiest first (then by name, so the order is stable). */
export function kindRows(rows: readonly KindStat[]): KindRow[] {
  const byKind = new Map<string, KindStat[]>()
  for (const row of rows) byKind.set(row.kind, [...(byKind.get(row.kind) ?? []), row])
  return [...byKind.entries()]
    .map(([kind, stats]) => ({
      kind,
      category: stats[0]?.category ?? '',
      ...outboxTotals(stats),
    }))
    .sort((a, b) => b.total - a.total || a.kind.localeCompare(b.kind))
}

export type NoticeTotals = {
  type: NoticeType
  total: number
  /** Sent, with no final report yet. */
  unreported: number
  delivered: number
  bounced: number
}

/** Every notice type, in the order they are sent, counted by delivery. */
export function noticeTotals(rows: readonly NoticeStat[]): NoticeTotals[] {
  return NOTICE_TYPES.map((type) => {
    const totals: NoticeTotals = { type, total: 0, unreported: 0, delivered: 0, bounced: 0 }
    for (const row of rows) {
      if (row.noticeType !== type) continue
      totals.total += row.count
      if (row.deliveryStatus === 'delivered') totals.delivered += row.count
      else if (row.deliveryStatus === 'bounced') totals.bounced += row.count
      else totals.unreported += row.count
    }
    return totals
  })
}
