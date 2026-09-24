import { CircleAlert, CircleCheck, CircleDashed, CircleMinus, Clock, UserRound } from 'lucide-react'
import Link from 'next/link'
import { DomainName } from '@/components/common/domain-name'
import { FOCUS } from '@/components/layout/panel'
import { cn } from '@/lib/utils'
import {
  type BulkKind,
  type BulkLine,
  type BulkParams,
  bulkSummary,
  describeLine,
  type LineDomain,
  type LineState,
  lineState,
  STATE_LABEL,
} from '../lib/bulk'

const STATE_ICON: Record<LineState, typeof CircleCheck> = {
  done: CircleCheck,
  waiting: Clock,
  attention: UserRound,
  failed: CircleAlert,
  unchanged: CircleMinus,
  skipped: CircleDashed,
}

/** Icon colour only — the state is always said in words beside it (S8). */
const STATE_TONE: Record<LineState, string> = {
  done: 'text-status-active',
  waiting: 'text-status-pending',
  attention: 'text-status-expiring',
  failed: 'text-destructive',
  unchanged: 'text-muted-foreground',
  skipped: 'text-muted-foreground',
}

const SUMMARY_ORDER: LineState[] = [
  'done',
  'waiting',
  'attention',
  'failed',
  'unchanged',
  'skipped',
]

/** The counts, in words: "2 done · 1 waiting". */
export function BulkSummary({ lines }: { lines: readonly BulkLine[] }) {
  const counts = bulkSummary(lines)
  return (
    <ul aria-label="Summary" className="flex flex-wrap gap-2 text-sm">
      {SUMMARY_ORDER.filter((state) => counts[state] > 0).map((state) => {
        const Icon = STATE_ICON[state]
        return (
          <li
            key={state}
            data-summary={state}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1 text-foreground"
          >
            <Icon className={cn('size-4', STATE_TONE[state])} aria-hidden="true" />
            {counts[state]} {STATE_LABEL[state].toLowerCase()}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * FR-P4 — each domain's outcome, in words: done, waiting on the registry,
 * held for a person, failed and why, or skipped and why.
 */
export function BulkResults({
  kind,
  params,
  lines,
  domains,
}: {
  kind: BulkKind
  params: BulkParams
  lines: readonly BulkLine[]
  domains: Record<string, LineDomain>
}) {
  if (lines.length === 0) {
    return (
      <p className="rounded-2xl border border-border border-dashed px-6 py-10 text-center text-sm text-muted-foreground">
        None of the domains chosen are on your account any more, so nothing was changed.
      </p>
    )
  }
  return (
    <ul aria-label="Each domain" className="space-y-2">
      {lines.map((line) => {
        const state = lineState(line)
        const Icon = STATE_ICON[state]
        return (
          <li
            key={line.domainId}
            data-bulk-line={line.domainName}
            data-state={state}
            className="flex flex-col gap-1.5 rounded-2xl border border-border bg-background/80 px-4 py-3.5 text-sm sm:flex-row sm:items-start sm:justify-between sm:gap-4 sm:px-5"
          >
            <Link
              href={`/app/domains/${line.domainName}`}
              className={cn(
                'min-w-0 rounded font-medium break-all text-foreground underline-offset-4 hover:underline',
                FOCUS,
              )}
            >
              <DomainName name={line.domainName} />
            </Link>
            <p className="flex min-w-0 items-start gap-2 text-pretty sm:max-w-[60%] sm:text-right">
              <Icon
                className={cn('mt-0.5 size-4 shrink-0 sm:order-last', STATE_TONE[state])}
                aria-hidden="true"
              />
              <span>
                <span className="font-medium text-foreground">{STATE_LABEL[state]}.</span>{' '}
                <span className="text-muted-foreground">
                  {describeLine(kind, params, line, domains[line.domainId])}
                </span>
              </span>
            </p>
          </li>
        )
      })}
    </ul>
  )
}
