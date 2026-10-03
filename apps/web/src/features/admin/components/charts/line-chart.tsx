import { cn } from '@/lib/utils'
import { type BarDatum, ChartTable } from './bar-chart'

/**
 * A line on the server, as SVG, with the same promises as BarChart: a named
 * `role="img"` and the figures in a table. Gaps (null) break the line rather
 * than pretending to a zero.
 */

export type LineDatum = Omit<BarDatum, 'value'> & { value: number | null }

const WIDTH = 320
const HEIGHT = 140
const TOP = 10
const BOTTOM = 124

export function LineChart({
  title,
  data,
  format = (value) => String(value),
  threshold,
  className,
}: {
  title: string
  data: LineDatum[]
  format?: (value: number) => string
  threshold?: { value: number; label: string }
  className?: string
}) {
  const values = data.flatMap((d) => (d.value === null ? [] : [d.value]))
  const max = Math.max(1, threshold?.value ?? 0, ...values)
  const min = Math.min(0, ...values)
  const step = WIDTH / Math.max(1, data.length)
  const y = (value: number) => BOTTOM - ((value - min) / (max - min || 1)) * (BOTTOM - TOP)

  const segments: string[] = []
  let current = ''
  data.forEach((d, index) => {
    if (d.value === null) {
      if (current) segments.push(current)
      current = ''
      return
    }
    const x = (index + 0.5) * step
    current += `${current ? 'L' : 'M'} ${x.toFixed(1)} ${y(d.value).toFixed(1)} `
  })
  if (current) segments.push(current)

  return (
    // `relative overflow-hidden`: the sr-only table never shrinks below its
    // content, and would otherwise widen a phone page (S5).
    <figure className={cn('relative min-w-0 overflow-hidden', className)}>
      <svg
        role="img"
        aria-label={`${title}. The figures follow in a table.`}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full overflow-visible"
      >
        <line x1="0" x2={WIDTH} y1={BOTTOM} y2={BOTTOM} strokeWidth="1" className="stroke-border" />
        {threshold ? (
          <line
            x1="0"
            x2={WIDTH}
            y1={y(threshold.value)}
            y2={y(threshold.value)}
            strokeWidth="1.5"
            strokeDasharray="5 4"
            className="stroke-status-redemption"
          />
        ) : null}
        {segments.map((d) => (
          <path
            key={d}
            d={d.trim()}
            fill="none"
            strokeWidth="2.5"
            strokeLinejoin="round"
            strokeLinecap="round"
            className="stroke-brand-ink"
          />
        ))}
      </svg>
      <figcaption className="mt-2 text-xs text-muted-foreground">
        {title}
        {threshold ? ` — dashed: ${threshold.label}` : ''}
      </figcaption>
      <ChartTable
        title={title}
        data={data.map((d) => ({ ...d, value: d.value ?? Number.NaN }))}
        format={(value) => (Number.isNaN(value) ? 'No data' : format(value))}
      />
    </figure>
  )
}
