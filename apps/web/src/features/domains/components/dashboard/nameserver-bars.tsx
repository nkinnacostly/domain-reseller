import { cn } from '@/lib/utils'
import type { Summary } from '../../lib/dashboard'
import { PANEL, plural } from './panel'

/**
 * Where the domains we hold point (FR-D5): working, a change still taking
 * effect, or not set yet. A domain that points nowhere is a website that
 * does not load — the most common thing a new customer needs help with.
 */
export function NameserverBars({
  nameservers,
  held,
  className,
}: {
  nameservers: Summary['nameservers']
  held: number
  className?: string
}) {
  const bars = [
    {
      label: 'Working',
      count: nameservers.working,
      tone: 'bg-brand text-brand-foreground',
      bubble: 'ring-1 ring-brand-foreground/45',
    },
    {
      label: 'Waiting',
      count: nameservers.waiting,
      tone: 'bg-foreground text-background',
      bubble: 'ring-1 ring-background/35',
    },
    {
      label: 'Not set',
      count: nameservers.notSet,
      tone: 'bg-muted-foreground/20 text-foreground',
      bubble: 'bg-background/80 ring-1 ring-border',
    },
  ]
  const tallest = Math.max(1, ...bars.map((bar) => bar.count))
  const percent = (count: number) => (held ? Math.round((count / held) * 100) : 0)

  return (
    <section
      aria-labelledby="nameservers-heading"
      className={cn(PANEL, 'flex flex-col p-5', className)}
    >
      <div className="flex items-start justify-between gap-4">
        <h2 id="nameservers-heading" className="font-medium text-foreground">
          Nameservers
        </h2>
        <p className="text-right">
          <span className="block text-2xl font-light tracking-tight text-foreground tabular-nums">
            {held}
          </span>
          <span className="text-xs text-muted-foreground">
            {held === 1 ? 'domain held' : 'domains held'}
          </span>
        </p>
      </div>

      {held === 0 ? (
        <p className="mt-auto pt-6 text-sm text-muted-foreground">
          Once a domain is registered, this shows whether it points at your host.
        </p>
      ) : (
        <ul className="mt-4 grid min-h-52 flex-1 grid-cols-3 items-end gap-2">
          {bars.map((bar) => (
            <li
              key={bar.label}
              // Tall enough for its labels, and otherwise to scale. An empty
              // bar is drawn as an outline, so its height never reads as a value.
              style={{ height: `${40 + (bar.count / tallest) * 60}%` }}
              className={cn(
                'flex flex-col items-center justify-between rounded-2xl px-1.5 pt-2 pb-3 text-center',
                bar.count > 0
                  ? bar.tone
                  : 'border border-border border-dashed text-muted-foreground',
              )}
            >
              <span
                className={cn(
                  'grid size-11 place-items-center rounded-full text-xs font-medium tabular-nums',
                  bar.count > 0 ? bar.bubble : 'ring-1 ring-border',
                )}
              >
                {percent(bar.count)}%
              </span>
              <span className="text-xs font-medium">
                {bar.label}
                <span className="sr-only">: {plural(bar.count, 'domain')}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
