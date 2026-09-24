import { ArrowUpRight, CalendarClock } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import type { RenewalMonth } from '../../lib/dashboard'
import { FOCUS, PANEL, plural, ROUND_LINK } from './panel'

/**
 * Renewals falling in each of the next six months (FR-P5), so a heavy month
 * is seen coming. An SVG line on the server, with the numbers also given as
 * a list for anyone not looking at the picture.
 */

const WIDTH = 320
const HEIGHT = 130
const TOP = 14
const BOTTOM = 116

export function RenewalsChart({
  months,
  total,
  className,
}: {
  months: RenewalMonth[]
  total: number
  className?: string
}) {
  const max = Math.max(1, ...months.map((month) => month.count))
  // Each point sits over the middle of its month's label below.
  const step = WIDTH / Math.max(1, months.length)
  const points = months.map((month, index) => ({
    x: (index + 0.5) * step,
    y: BOTTOM - (month.count / max) * (BOTTOM - TOP),
  }))
  const line = points.map((p, index) => `${index === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
  const first = points[0]?.x ?? 0
  const last = points.at(-1)?.x ?? WIDTH
  const area = `${line} L ${last} ${HEIGHT} L ${first} ${HEIGHT} Z`
  const average = total / Math.max(1, months.length)
  const averageY = BOTTOM - (average / max) * (BOTTOM - TOP)

  return (
    <section
      aria-labelledby="renewals-chart-heading"
      className={cn(PANEL, 'flex flex-col p-5', className)}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="mt-2 grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-background text-muted-foreground"
          >
            <CalendarClock className="size-4" />
          </span>
          <div>
            <p className="text-4xl font-light tracking-tight text-foreground tabular-nums">
              {total}
            </p>
            <h2 id="renewals-chart-heading" className="text-sm text-muted-foreground">
              Renewals in the next six months
            </h2>
          </div>
        </div>
        <Link
          href="/app/domains?within=90#portfolio"
          aria-label="Renewals in the next 90 days"
          className={cn(ROUND_LINK, FOCUS)}
        >
          <ArrowUpRight className="size-5" aria-hidden="true" />
        </Link>
      </div>

      <div className="mt-auto pt-6">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          aria-hidden="true"
          className="h-auto w-full overflow-visible"
        >
          <defs>
            <linearGradient id="renewals-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" className="[stop-color:var(--brand)] [stop-opacity:0.18]" />
              <stop offset="100%" className="[stop-color:var(--brand)] [stop-opacity:0]" />
            </linearGradient>
          </defs>
          <line
            x1="0"
            x2={WIDTH}
            y1={averageY}
            y2={averageY}
            strokeWidth="1"
            strokeDasharray="4 4"
            className="stroke-muted-foreground/40"
          />
          <path d={area} fill="url(#renewals-fill)" />
          <path
            d={line}
            fill="none"
            strokeWidth="2.5"
            strokeLinejoin="round"
            strokeLinecap="round"
            className="stroke-brand-ink"
          />
          {points.map((p, index) => (
            <circle
              key={months[index]?.key}
              cx={p.x}
              cy={p.y}
              r="3.5"
              strokeWidth="2"
              className="fill-card stroke-brand-ink"
            />
          ))}
        </svg>
        <ol className="mt-3 grid grid-cols-6 text-center text-xs text-muted-foreground">
          {months.map((month) => (
            <li key={month.key}>
              <span aria-hidden="true">{month.label}</span>
              <span className="sr-only">
                {month.label}: {plural(month.count, 'renewal')}
              </span>
            </li>
          ))}
        </ol>
        {total === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Nothing is due for renewal in the next six months.
          </p>
        ) : null}
      </div>
    </section>
  )
}
