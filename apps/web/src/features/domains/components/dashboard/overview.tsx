import { CalendarClock, CircleCheck, Globe, Plus, Receipt } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { greeting, type Summary, todayLine } from '../../lib/dashboard'
import { AutoRenewGauge } from './gauge'
import { FOCUS, PANEL, ROUND_LINK } from './panel'

/**
 * The top of the portfolio (FR-P1): who is signed in, today's date, the
 * portfolio in four numbers, and how much of it renews by itself.
 */
export function Overview({
  firstName,
  summary,
  orderCount,
  now,
}: {
  firstName: string | null
  summary: Summary
  orderCount: number
  now: Date
}) {
  const stats = [
    { label: 'Domains', value: summary.total, icon: Globe },
    { label: 'Active', value: summary.active, icon: CircleCheck },
    { label: 'Due within 30 days', value: summary.dueWithin30, icon: CalendarClock },
    { label: 'Orders', value: orderCount, icon: Receipt },
  ]

  return (
    <section
      aria-labelledby="overview-heading"
      className={cn(PANEL, 'relative overflow-hidden p-5 sm:p-7')}
    >
      {/* The pale blue wash the reference's warm glow becomes. Decorative. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-radial-[at_85%_40%] from-brand/12 via-transparent to-transparent"
      />

      <div className="relative flex items-center justify-between gap-4">
        <nav aria-label="Breadcrumb">
          <ol className="flex items-center gap-2 text-sm">
            <li>
              <Link
                href="/"
                className={cn('rounded text-foreground underline-offset-4 hover:underline', FOCUS)}
              >
                Home
              </Link>
            </li>
            <li aria-hidden="true" className="text-muted-foreground">
              /
            </li>
            <li aria-current="page" className="text-muted-foreground">
              Dashboard
            </li>
          </ol>
        </nav>
        <div className="flex items-center gap-2">
          <Link
            href="/app/domains/expiring"
            aria-label="Renewal dates"
            className={cn(ROUND_LINK, 'rounded-xl', FOCUS)}
          >
            <CalendarClock className="size-5" aria-hidden="true" />
          </Link>
          <Link
            href="/search"
            aria-label="Register a new domain"
            className={cn(ROUND_LINK, 'rounded-xl', FOCUS)}
          >
            <Plus className="size-5" aria-hidden="true" />
          </Link>
        </div>
      </div>

      <div className="relative mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_15rem] lg:items-center">
        <div className="min-w-0">
          <h1
            id="overview-heading"
            className="text-3xl font-normal tracking-tight text-balance text-foreground sm:text-4xl"
          >
            {greeting(now)}
            {firstName ? `, ${firstName}` : ''}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">{todayLine(now)}</p>

          <hr className="mt-6 border-border border-dashed" />

          <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-4">
            {stats.map(({ label, value, icon: Icon }) => (
              <div key={label} className="flex min-w-0 flex-col gap-1">
                <dt className="order-2 text-sm text-muted-foreground">{label}</dt>
                <dd className="order-1 flex items-center gap-2.5">
                  <span
                    aria-hidden="true"
                    className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-background text-muted-foreground"
                  >
                    <Icon className="size-4" />
                  </span>
                  <span className="text-4xl font-light tracking-tight text-foreground tabular-nums">
                    {value}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <AutoRenewGauge
          share={summary.autoRenewShare}
          on={summary.held - summary.autoRenewOff}
          held={summary.held}
        />
      </div>
    </section>
  )
}
