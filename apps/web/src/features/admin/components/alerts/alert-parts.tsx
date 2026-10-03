import { Info, OctagonAlert, TriangleAlert } from 'lucide-react'
import Link from 'next/link'
import { QUIET_BUTTON } from '@/components/common/action-parts'
import { EmptyState } from '@/features/admin/components/empty-state'
import { RouteTabs } from '@/features/admin/components/route-tabs'
import { TAB_LABEL } from '@/features/admin/lib/alerts-copy'
import { ALERT_TABS, type AlertTab, alertsTabHref } from '@/features/admin/lib/alerts-params'
import { ago, formatWat } from '@/features/admin/lib/format'
import { labelFor, SEVERITY_LABEL } from '@/features/admin/lib/labels'
import { TONE_CLASS, type Tone } from '@/features/admin/lib/tone'
import { cn } from '@/lib/utils'

/**
 * The alerts page's small pieces (ADMIN-SPEC §5.2, B5): its tabs, a
 * severity in an icon and a word, a time with its age, and a note.
 */

/**
 * The four views as links: the URL says which is open (`?tab=`). All four
 * share one path, so the page says which is current; RouteTabs marks it
 * with `aria-current="page"`, a tick and heavier words (S13).
 */
export function AlertTabs({ current }: { current: AlertTab }) {
  return (
    <RouteTabs
      label="Alert views"
      tabs={ALERT_TABS.map((tab) => ({
        href: alertsTabHref(tab),
        label: TAB_LABEL[tab],
        current: tab === current,
      }))}
    />
  )
}

const SEVERITY_TONE: Record<string, Tone> = { critical: 'danger', warning: 'warning' }

/** "Critical" or "Warning", with an icon of its own shape — never colour alone (S8). */
export function SeverityPill({ severity }: { severity: string }) {
  const Icon = severity === 'critical' ? OctagonAlert : TriangleAlert
  return (
    <span
      data-tone={SEVERITY_TONE[severity] ?? 'neutral'}
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium whitespace-nowrap text-foreground',
        TONE_CLASS[SEVERITY_TONE[severity] ?? 'neutral'],
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {labelFor(SEVERITY_LABEL, severity)}
    </span>
  )
}

/** A Lagos time, with how long ago underneath. */
export function SeenAt({ at, now }: { at: string | null; now: Date }) {
  if (!at) return <span className="text-muted-foreground">—</span>
  return (
    <span className="inline-flex flex-col">
      <time dateTime={at} className="whitespace-nowrap">
        {formatWat(at)}
      </time>
      <span className="text-xs text-muted-foreground">{ago(at, now)}</span>
    </span>
  )
}

/** A line that explains how a list behaves. */
export function AlertsNote({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <p
      role="note"
      data-testid={testId}
      className="flex items-start gap-2 px-1 text-sm text-muted-foreground"
    >
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}

/** A section of the page: its heading, what it says about itself, and its content. */
export function AlertsSection({
  id,
  title,
  children,
  aside,
}: {
  id: string
  title: string
  children: React.ReactNode
  /** Beside the heading: a count, a link. */
  aside?: React.ReactNode
}) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-1">
        <h2 id={id} className="text-lg font-medium text-foreground">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

/**
 * A page number past the end — an old link, or rows that closed since —
 * says so and offers the first page, rather than claiming the list is empty.
 */
export function PastTheLastPage({ firstPage }: { firstPage: string }) {
  return (
    <EmptyState
      title="Nothing on this page"
      body="The list is shorter than this page number now: rows may have closed since the link was made."
      action={
        <Link href={firstPage} className={QUIET_BUTTON}>
          Go to the first page
        </Link>
      }
    />
  )
}
