import { CircleCheck, Clock, RotateCw } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { evaluateStatus, formatStatusTime, type LineState } from '../lib/status'
import { getPublicStatus } from '../queries/status'

/**
 * Each state has its own icon *and* its own word, so nothing relies on colour
 * alone (S8, WCAG 1.4.1). Text stays in the foreground colour: the status hues
 * are too light for small text on their own tint.
 */
const STATE: Record<LineState, { label: string; icon: typeof Clock; tone: string }> = {
  operational: {
    label: 'Operational',
    icon: CircleCheck,
    tone: 'bg-status-active/15 border-status-active/40 [--dot:var(--status-active)]',
  },
  delayed: {
    label: 'Delayed',
    icon: Clock,
    tone: 'bg-status-expiring/15 border-status-expiring/50 [--dot:var(--status-expiring)]',
  },
}

function StatePill({ state }: { state: LineState }) {
  const { label, icon: Icon, tone } = STATE[state]
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium text-foreground',
        tone,
      )}
    >
      <Icon className="size-4 text-(--dot)" aria-hidden="true" />
      {label}
    </span>
  )
}

function CheckAgain() {
  return (
    <Link
      href="/status"
      className="inline-flex h-11 items-center gap-2 rounded-full border border-border bg-background px-6 text-sm font-medium text-foreground transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
    >
      <RotateCw className="size-4" aria-hidden="true" />
      Check again
    </Link>
  )
}

/**
 * The live service status (read on every visit, never cached). Each line says
 * what it covers and what the data shows — nothing it cannot see (N9b).
 */
export async function ServiceStatus() {
  const status = await getPublicStatus()

  if (!status) {
    return (
      <section aria-labelledby="status-heading">
        <div className="rounded-[2rem] border border-border border-dashed p-8 sm:p-12">
          <h2 id="status-heading" className="text-2xl font-bold tracking-tight sm:text-3xl">
            We couldn&apos;t read the service status
          </h2>
          <p className="mt-3 max-w-xl text-pretty text-muted-foreground">
            The status could not be fetched just now, so this page cannot say either way. Try again
            in a minute.
          </p>
          <div className="mt-6">
            <CheckAgain />
          </div>
        </div>
      </section>
    )
  }

  const report = evaluateStatus(status)

  return (
    <section aria-labelledby="status-heading">
      <div
        className={cn(
          'rounded-[2rem] border p-7 sm:p-10',
          report.overall === 'operational'
            ? 'border-status-active/40 bg-status-active/10'
            : 'border-status-expiring/50 bg-status-expiring/10',
        )}
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <h2 id="status-heading" className="text-2xl font-bold tracking-tight sm:text-3xl">
            {report.overall === 'operational'
              ? 'Everything is running normally'
              : 'Some things are delayed'}
          </h2>
          <StatePill state={report.overall} />
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          Checked at {formatStatusTime(report.checkedAt)}, Lagos time.
        </p>
      </div>

      <ul aria-label="Services" className="mt-8 divide-y divide-border/70">
        {report.lines.map((line) => (
          <li key={line.id} data-state={line.state} className="py-6 first:pt-0">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
              <div className="min-w-0">
                <h3 className="font-semibold text-foreground">{line.title}</h3>
                <p className="mt-1 text-pretty text-sm/6 text-muted-foreground">{line.meaning}</p>
              </div>
              <StatePill state={line.state} />
            </div>
            <p className="mt-3 max-w-2xl text-pretty text-sm/6 text-foreground">{line.detail}</p>
          </li>
        ))}
      </ul>

      <div className="mt-4">
        <CheckAgain />
      </div>
    </section>
  )
}

export function ServiceStatusSkeleton() {
  return (
    <div role="status" aria-label="Checking the service status" className="animate-pulse">
      <div className="h-36 rounded-[2rem] bg-muted/60" />
      <div className="mt-8 space-y-6">
        <div className="h-20 rounded-2xl bg-muted/60" />
        <div className="h-20 rounded-2xl bg-muted/60" />
        <div className="h-20 rounded-2xl bg-muted/60" />
      </div>
    </div>
  )
}
