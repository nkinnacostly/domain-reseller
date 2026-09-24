import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { PANEL_HEADING, Panel, PanelSkeleton } from '@/components/layout/panel'
import { describeEvent } from '@/features/domains/lib/activity'
import { getDomain, getDomainEvents } from '@/features/domains/queries/domains'

export const metadata: Metadata = { title: 'Activity' }
type Params = Promise<{ domain: string }>

const timeFormat = new Intl.DateTimeFormat('en-NG', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Africa/Lagos',
})

async function Activity({ params }: { params: Params }) {
  const { domain: name } = await params
  const domain = await getDomain(name)
  if (!domain) notFound()
  const events = await getDomainEvents(domain.id)

  return (
    <Panel labelledBy="activity-heading">
      <h2 id="activity-heading" className={PANEL_HEADING}>
        Activity
      </h2>
      {events.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Nothing has happened to this domain yet.
        </p>
      ) : (
        <ol aria-label="Activity" className="mt-4 space-y-2">
          {events.map((event) => (
            <li
              key={event.id}
              className="flex flex-col gap-1 rounded-2xl border border-border bg-background/80 px-5 py-3.5 text-sm sm:flex-row sm:justify-between sm:gap-4"
            >
              <span className="text-foreground">
                {describeEvent(event.event_type, (event.payload ?? {}) as Record<string, unknown>)}
                <span className="ml-2 text-xs text-muted-foreground">
                  {event.actor_type === 'user' ? 'by you' : 'by us'}
                </span>
              </span>
              <time dateTime={event.created_at} className="shrink-0 text-muted-foreground">
                {timeFormat.format(new Date(event.created_at))}
              </time>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  )
}

export default function ActivityPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<PanelSkeleton height="h-48" />}>
      <Activity params={params} />
    </Suspense>
  )
}
