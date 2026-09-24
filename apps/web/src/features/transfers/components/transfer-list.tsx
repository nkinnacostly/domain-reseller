import Link from 'next/link'
import { DomainName } from '@/components/common/domain-name'
import { DomainStatusPill } from '@/components/common/domain-status-pill'
import { FOCUS, PANEL_HEADING } from '@/components/layout/panel'
import { cn } from '@/lib/utils'
import { isTransferOpen, STAGE_NOTE, transferStage } from '../lib/progress'
import type { TransferRow } from '../queries/transfers'

const dateFormat = new Intl.DateTimeFormat('en-NG', {
  dateStyle: 'medium',
  timeZone: 'Africa/Lagos',
})

/** PRD E9 — transfers in, the ones still moving first. */
export function TransferList({ transfers }: { transfers: TransferRow[] }) {
  if (transfers.length === 0) {
    return (
      <div className="rounded-2xl border border-border border-dashed px-6 py-12 text-center">
        <p className="text-muted-foreground">You haven’t transferred a domain here yet.</p>
        <Link
          href="/transfer"
          className={cn(
            'mt-4 inline-flex h-11 items-center rounded-full bg-accent px-6 text-sm font-medium text-accent-foreground transition hover:bg-accent/90 active:scale-[0.98]',
            FOCUS,
          )}
        >
          Check a domain you own
        </Link>
      </div>
    )
  }

  const open = transfers.filter((row) => isTransferOpen(transferStage(row.status)))
  const finished = transfers.filter((row) => !isTransferOpen(transferStage(row.status)))
  return (
    <div className="space-y-8">
      {open.length > 0 ? <Group id="open" title="In progress" rows={open} /> : null}
      {finished.length > 0 ? <Group id="finished" title="Finished" rows={finished} /> : null}
    </div>
  )
}

function Group({ id, title, rows }: { id: string; title: string; rows: TransferRow[] }) {
  return (
    <section aria-labelledby={`transfers-${id}`}>
      <h2 id={`transfers-${id}`} className={PANEL_HEADING}>
        {title}
      </h2>
      <ul aria-label={title} className="mt-3 space-y-2">
        {rows.map((row) => (
          <TransferItem key={row.id} row={row} />
        ))}
      </ul>
    </section>
  )
}

function TransferItem({ row }: { row: TransferRow }) {
  const stage = transferStage(row.status)
  return (
    <li
      data-transfer={row.domainName}
      className="rounded-2xl border border-border bg-background/80 px-5 py-4"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            {stage === 'done' ? (
              <Link
                href={`/app/domains/${row.domainName}`}
                className="font-medium break-all text-foreground underline-offset-4 hover:underline"
              >
                <DomainName name={row.domainName} />
              </Link>
            ) : (
              <span className="font-medium break-all text-foreground">
                <DomainName name={row.domainName} />
              </span>
            )}
            <DomainStatusPill status={row.status} />
            {row.testMode ? <span className="text-xs text-muted-foreground">test</span> : null}
          </p>
          <p className="mt-1 text-pretty text-sm/6 text-muted-foreground">
            {STAGE_NOTE[stage](row.testMode)}
          </p>
        </div>
        <dl className="shrink-0 space-y-0.5 text-sm text-muted-foreground sm:text-right">
          <div>
            <dt className="sr-only">Started</dt>
            <dd>Started {dateFormat.format(new Date(row.startedAt))}</dd>
          </div>
          {row.submittedAt ? (
            <div>
              <dt className="sr-only">At the registry</dt>
              <dd>At the registry {dateFormat.format(new Date(row.submittedAt))}</dd>
            </div>
          ) : null}
        </dl>
      </div>
      {row.orderId ? (
        <Link
          href={`/app/orders/${row.orderId}`}
          className={cn(
            'mt-3 inline-flex h-11 items-center text-sm font-medium text-foreground underline-offset-4 hover:underline',
            FOCUS,
          )}
        >
          Order {row.orderNumber}
        </Link>
      ) : null}
    </li>
  )
}
