import { cn } from '@/lib/utils'

/**
 * How much of the portfolio renews by itself — the one number that says
 * whether a domain could lapse unnoticed. A 270° dial, drawn on the server:
 * no chart library, nothing to hydrate.
 */

const CX = 110
const CY = 105
const START = 135
const SWEEP = 270
const TICKS = [0, 20, 40, 60, 80, 100]

function point(angle: number, radius: number): [number, number] {
  const rad = (angle * Math.PI) / 180
  return [CX + radius * Math.cos(rad), CY + radius * Math.sin(rad)]
}

function arc(from: number, to: number, radius: number): string {
  const [x1, y1] = point(from, radius)
  const [x2, y2] = point(to, radius)
  const large = to - from > 180 ? 1 : 0
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`
}

export function AutoRenewGauge({
  share,
  on,
  held,
  className,
}: {
  /** 0–100, or null when there is nothing to renew. */
  share: number | null
  on: number
  held: number
  className?: string
}) {
  const value = share ?? 0
  const end = START + (SWEEP * value) / 100
  const [knobX, knobY] = point(end, 74)
  const label =
    share === null
      ? 'Auto-renew: no domains to renew yet'
      : `Auto-renew is on for ${share}% of your domains (${on} of ${held})`

  return (
    <div
      role="img"
      aria-label={label}
      className={cn('relative mx-auto aspect-[220/190] w-full max-w-[15rem]', className)}
    >
      <svg viewBox="0 0 220 190" aria-hidden="true" className="size-full overflow-visible">
        <path
          d={arc(START, START + SWEEP, 74)}
          fill="none"
          strokeWidth="14"
          strokeLinecap="round"
          className="stroke-brand-subtle-border"
        />
        {share !== null && value > 0 ? (
          <path
            d={arc(START, end, 74)}
            fill="none"
            strokeWidth="14"
            strokeLinecap="round"
            className="stroke-brand"
          />
        ) : null}
        {share !== null ? (
          <circle cx={knobX} cy={knobY} r="10" strokeWidth="4" className="fill-card stroke-brand" />
        ) : null}
        {TICKS.map((tick) => {
          const [x, y] = point(START + (SWEEP * tick) / 100, 96)
          return (
            <text
              key={tick}
              x={x}
              y={y}
              textAnchor="middle"
              dominantBaseline="middle"
              className="fill-muted-foreground text-[9px]"
            >
              {String(tick).padStart(2, '0')}
            </text>
          )
        })}
      </svg>
      <div className="absolute inset-x-0 top-[40%] flex flex-col items-center text-center">
        <span className="text-4xl font-light tracking-tight text-foreground tabular-nums">
          {share === null ? '—' : `${share}%`}
        </span>
        <span className="mt-1 text-xs text-muted-foreground">
          {share === null ? 'Nothing to renew yet' : 'Renew automatically'}
        </span>
      </div>
    </div>
  )
}
