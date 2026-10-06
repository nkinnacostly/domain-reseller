import { ArrowRight, CircleCheck, CircleDashed, CircleHelp, TriangleAlert } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import type { NextStep } from '../lib/steps'
import { formatCount, METER_WORDS, type Meter, type UsageCounts } from '../lib/usage'

/**
 * The Overview's parts (MAIL-SPEC §10). Server components: the figures come
 * from SQL (`account_usage`), and nothing here is estimated or sampled.
 */

const BAR: Record<Meter['level'], string> = {
  ok: 'bg-primary',
  warning: 'bg-tone-warning-foreground',
  reached: 'bg-tone-danger-foreground',
}

/** A cap and its use, as a meter with its numbers and, past 80%, words (S8). */
export function UsageMeter({
  label,
  meter,
  unit = 'emails',
}: {
  label: string
  meter: Meter
  unit?: string
}) {
  const words = METER_WORDS[meter.level]
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-sm tabular-nums text-muted-foreground">
          <span className="font-semibold text-foreground">{formatCount(meter.used)}</span> of{' '}
          {formatCount(meter.cap)} {unit}
        </p>
      </div>
      {/* The native meter carries the value for assistive tech; the bar draws it. */}
      <meter
        aria-label={label}
        min={0}
        max={meter.cap}
        value={Math.min(meter.used, meter.cap)}
        aria-valuetext={`${formatCount(meter.used)} of ${formatCount(meter.cap)} ${unit}, ${meter.percent}%`}
        className="sr-only"
      />
      <div aria-hidden="true" className="mt-2 h-2.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full', BAR[meter.level])}
          style={{ width: `${meter.percent}%` }}
        />
      </div>
      {words ? (
        <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-tone-warning-foreground">
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          {words}
        </p>
      ) : null}
    </div>
  )
}

const COUNT_LABELS: [keyof UsageCounts, string][] = [
  ['queued', 'Accepted'],
  ['sent', 'Sent'],
  ['delivered', 'Delivered'],
  ['bounced', 'Bounced'],
  ['complained', 'Marked as spam'],
  ['failed', 'Failed'],
]

/** Today's sends by what happened to them, in recipients. */
export function DayCounts({ counts }: { counts: UsageCounts }) {
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {COUNT_LABELS.map(([key, label]) => (
        <div key={key} className="rounded-2xl bg-muted px-4 py-3">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="mt-1 text-xl font-semibold tabular-nums">{formatCount(counts[key])}</dd>
        </div>
      ))}
    </dl>
  )
}

const STEP_STATE = {
  done: { icon: CircleCheck, words: 'Done', className: 'text-tone-success-foreground' },
  todo: { icon: CircleDashed, words: 'To do', className: 'text-muted-foreground' },
  unknown: {
    icon: CircleHelp,
    words: 'Ask a developer or admin',
    className: 'text-muted-foreground',
  },
} as const

/** What stands between this account and sending, each marked in words and an icon. */
export function NextStepsList({ steps }: { steps: NextStep[] }) {
  return (
    <ol className="divide-y divide-border">
      {steps.map((step) => {
        const state = STEP_STATE[step.done === null ? 'unknown' : step.done ? 'done' : 'todo']
        const Icon = state.icon
        return (
          <li key={step.id} data-step={step.id} className="flex gap-3 py-4 first:pt-0 last:pb-0">
            <Icon className={cn('mt-0.5 size-5 shrink-0', state.className)} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {step.title}
                <span className={cn('ml-2 text-xs font-medium', state.className)}>
                  {state.words}
                </span>
              </p>
              <p className="mt-1 text-pretty text-sm/6 text-muted-foreground">{step.detail}</p>
              {step.href && step.done === false ? (
                <Link
                  href={step.href}
                  className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-sm text-sm font-medium text-brand-ink underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {step.title}
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
              ) : null}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/** An async part that could not load: what happened and the one thing to try (S11). */
export function PartError({ what, retryHref }: { what: string; retryHref: string }) {
  return (
    <div
      role="alert"
      className="rounded-2xl bg-tone-danger px-4 py-3 text-sm/6 text-tone-danger-foreground"
    >
      <p className="font-semibold">We couldn’t load {what}</p>
      <p>
        Nothing has changed in your account.{' '}
        <a
          href={retryHref}
          className="rounded-sm font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Try again
        </a>
      </p>
    </div>
  )
}
