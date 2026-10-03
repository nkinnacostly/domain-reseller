import { cn } from '@/lib/utils'

/**
 * Bars on the server, as SVG (CLAUDE.md: no chart library). The picture is
 * `role="img"` with a name; the numbers are also a table for anyone not
 * looking at it (ADMIN-SPEC §5.3). Brand and status tokens only (S2).
 */

export type BarDatum = { key: string; label: string; value: number }

const WIDTH = 320
const HEIGHT = 140
const TOP = 8
const BOTTOM = 124

export function BarChart({
  title,
  data,
  format = (value) => String(value),
  threshold,
  className,
}: {
  title: string
  data: BarDatum[]
  format?: (value: number) => string
  /** A dashed line across, e.g. an alert level, with its own words. */
  threshold?: { value: number; label: string }
  className?: string
}) {
  const max = Math.max(1, threshold?.value ?? 0, ...data.map((d) => Math.max(0, d.value)))
  const step = WIDTH / Math.max(1, data.length)
  const barWidth = Math.max(2, step * 0.62)
  const y = (value: number) => BOTTOM - (Math.max(0, value) / max) * (BOTTOM - TOP)

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
        {data.map((d, index) => (
          <rect
            key={d.key}
            x={index * step + (step - barWidth) / 2}
            y={y(d.value)}
            width={barWidth}
            height={Math.max(0, BOTTOM - y(d.value))}
            rx="2"
            className="fill-brand"
          />
        ))}
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
      </svg>
      <figcaption className="mt-2 text-xs text-muted-foreground">
        {title}
        {threshold ? ` — dashed: ${threshold.label}` : ''}
      </figcaption>
      <ChartTable title={title} data={data} format={format} />
    </figure>
  )
}

/** The chart's figures, for screen readers. */
export function ChartTable({
  title,
  data,
  format,
}: {
  title: string
  data: BarDatum[]
  format: (value: number) => string
}) {
  return (
    <table className="sr-only">
      <caption>{title}</caption>
      <thead>
        <tr>
          <th scope="col">Period</th>
          <th scope="col">Value</th>
        </tr>
      </thead>
      <tbody>
        {data.map((d) => (
          <tr key={d.key}>
            <th scope="row">{d.label}</th>
            <td>{format(d.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
