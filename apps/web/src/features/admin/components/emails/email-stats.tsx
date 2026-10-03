import Link from 'next/link'
import { PANEL_HEADING, Panel } from '@/components/layout/panel'
import { StatTile } from '@/features/admin/components/stat-tile'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import {
  CATEGORY_LABEL,
  kindLabel,
  NOTICE_WINDOW,
  noticeTypeLabel,
  STATS_HEADING,
} from '@/features/admin/lib/emails-copy'
import { emailsHref, type OutboxParams } from '@/features/admin/lib/emails-params'
import {
  type KindRow,
  kindRows,
  noticeTotals,
  outboxTotals,
} from '@/features/admin/lib/emails-stats'
import { formatCount } from '@/features/admin/lib/format'
import type { EmailStats } from '@/features/admin/queries/emails'
import { LINK } from './email-parts'

/**
 * The emails page's figures for the last 30 days, from `admin_email_stats`
 * (docs/ADMIN-SPEC.md §3.2h). Each tile links to the list with its filter;
 * the list itself is not limited to the 30 days.
 */

const HINT = 'Queued in the last 30 days'

export function OutboxFigures({ stats, params }: { stats: EmailStats; params: OutboxParams }) {
  const totals = outboxTotals(stats.byKind)
  const link = (status: OutboxParams['status']) =>
    emailsHref(params, { status, category: null, kind: null, from: null, to: null })
  return (
    <section aria-labelledby="emails-figures-heading" className="space-y-3">
      <h2 id="emails-figures-heading" className="px-1 font-medium text-foreground">
        {STATS_HEADING}
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <StatTile
          label="Failed"
          value={formatCount(totals.failed)}
          hint={HINT}
          href={link('failed')}
          tone={totals.failed > 0 ? 'danger' : 'neutral'}
        />
        <StatTile
          label="Waiting to send"
          value={formatCount(totals.waiting)}
          hint={HINT}
          href={link('pending')}
          tone={totals.waiting > 0 ? 'info' : 'neutral'}
        />
        <StatTile label="Sent" value={formatCount(totals.sent)} hint={HINT} href={link('sent')} />
        <StatTile
          label="Delivered"
          value={formatCount(totals.delivered)}
          hint="Reported delivered by the provider"
        />
        <StatTile
          label="Bounced"
          value={formatCount(totals.bounced)}
          hint={HINT}
          href={link('bounced')}
          tone={totals.bounced > 0 ? 'warning' : 'neutral'}
        />
        <StatTile
          label="Skipped"
          value={formatCount(totals.skipped)}
          hint="Never sent, by design"
          href={link('skipped')}
        />
      </div>
    </section>
  )
}

function kindColumns(params: OutboxParams): Column<KindRow>[] {
  const figure = (key: keyof KindRow & string, header: string): Column<KindRow> => ({
    key,
    header,
    numeric: true,
    cell: (row) => formatCount(row[key] as number),
  })
  return [
    {
      key: 'kind',
      header: 'Kind',
      cell: (row) => (
        <Link
          href={emailsHref(params, { kind: row.kind, status: null, category: null })}
          className={LINK}
        >
          {kindLabel(row.kind)}
        </Link>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      cell: (row) =>
        CATEGORY_LABEL[row.category as keyof typeof CATEGORY_LABEL] ?? (row.category || '—'),
    },
    figure('total', 'Queued'),
    figure('sent', 'Sent'),
    figure('delivered', 'Delivered'),
    figure('bounced', 'Bounced'),
    figure('failed', 'Failed'),
    figure('skipped', 'Skipped'),
    figure('waiting', 'Waiting'),
  ]
}

/** One row per kind of email: how many were queued and what became of them. */
export function KindTable({ stats, params }: { stats: EmailStats; params: OutboxParams }) {
  const rows = kindRows(stats.byKind)
  return (
    <Panel labelledBy="emails-kinds-heading" className="space-y-4">
      <h2 id="emails-kinds-heading" className={PANEL_HEADING}>
        By kind, {STATS_HEADING.toLowerCase()}
      </h2>
      <DataTable
        caption={`Emails by kind, ${STATS_HEADING.toLowerCase()}`}
        rows={rows}
        columns={kindColumns(params)}
        rowKey={(row) => row.kind}
        empty={<p className="text-sm text-foreground">No emails were queued in that time.</p>}
      />
    </Panel>
  )
}

/** The notices sent in the last 30 days, by type and delivery. */
export function NoticeFigures({ stats }: { stats: EmailStats }) {
  return (
    <section aria-labelledby="notices-figures-heading" className="space-y-3">
      <h2 id="notices-figures-heading" className="px-1 font-medium text-foreground">
        Notices sent, {STATS_HEADING.toLowerCase()}
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {noticeTotals(stats.notices).map((totals) => (
          <StatTile
            key={totals.type}
            label={noticeTypeLabel(totals.type)}
            value={formatCount(totals.total)}
            hint={`Sent ${NOTICE_WINDOW[totals.type]}. ${formatCount(totals.delivered)} delivered · ${formatCount(totals.bounced)} bounced · ${formatCount(totals.unreported)} no report yet`}
            tone={totals.bounced > 0 ? 'danger' : 'neutral'}
          />
        ))}
      </div>
    </section>
  )
}
