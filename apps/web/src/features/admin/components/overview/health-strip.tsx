import Link from 'next/link'
import { FOCUS, PANEL_HEADING, Panel } from '@/components/layout/panel'
import { AdminStatusPill } from '@/features/admin/components/admin-status-pill'
import type { HealthItem } from '@/features/admin/lib/overview-health'
import { cn } from '@/lib/utils'

/**
 * The services behind the shop, each as a dot and a word with when it last
 * reported (docs/ADMIN-SPEC.md §5.2 B1). The word carries the meaning; the
 * dot only colours it (S8).
 */
export function HealthStrip({ items }: { items: HealthItem[] }) {
  return (
    <Panel labelledBy="overview-health-heading">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 id="overview-health-heading" className={PANEL_HEADING}>
          Health
        </h2>
        <Link
          href="/admin/alerts?tab=health"
          className={cn(
            'inline-flex min-h-11 items-center rounded text-sm text-foreground underline underline-offset-4 hover:no-underline active:opacity-80',
            FOCUS,
          )}
        >
          Every check, with its history
        </Link>
      </div>
      <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {items.map((item) => (
          <li
            key={item.key}
            data-health={item.key}
            className="min-w-0 rounded-2xl border border-border bg-background/70 p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium text-foreground">{item.label}</span>
              <AdminStatusPill value={item.word} tone={item.tone} />
            </div>
            <p className="mt-1.5 text-xs/5 break-words text-muted-foreground">{item.detail}</p>
          </li>
        ))}
      </ul>
    </Panel>
  )
}
