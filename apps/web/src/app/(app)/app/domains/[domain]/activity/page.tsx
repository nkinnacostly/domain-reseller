import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { getDomain, getDomainEvents } from '@/features/domains/queries/domains'

export const metadata: Metadata = { title: 'Activity' }
type Params = Promise<{ domain: string }>

const timeFormat = new Intl.DateTimeFormat('en-NG', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Africa/Lagos',
})

function describe(type: string, payload: Record<string, unknown>): string {
  switch (type) {
    case 'order_paid':
      return `Paid for in order ${payload.order_number ?? ''}`.trim()
    case 'nameservers_requested':
      return `Nameserver change requested: ${((payload.after as string[] | undefined) ?? []).join(', ')}`
    case 'auto_renew_on':
      return 'Auto-renew turned on'
    case 'auto_renew_off':
      return 'Auto-renew turned off'
    case 'demo_created':
      return 'Added as a demo domain'
    default:
      return type.replaceAll('_', ' ')
  }
}

async function Activity({ params }: { params: Params }) {
  const { domain: name } = await params
  const domain = await getDomain(name)
  if (!domain) notFound()
  const events = await getDomainEvents(domain.id)

  if (events.length === 0) {
    return <p className="text-muted-foreground">Nothing has happened to this domain yet.</p>
  }
  return (
    <ol
      aria-label="Activity"
      className="max-w-2xl divide-y divide-border/70 rounded-2xl border border-border"
    >
      {events.map((event) => (
        <li
          key={event.id}
          className="flex flex-col gap-1 px-5 py-3.5 text-sm sm:flex-row sm:justify-between sm:gap-4"
        >
          <span className="text-foreground">
            {describe(event.event_type, (event.payload ?? {}) as Record<string, unknown>)}
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
  )
}

export default function ActivityPage({ params }: { params: Params }) {
  return (
    <Suspense
      fallback={<div aria-hidden="true" className="h-48 animate-pulse rounded-2xl bg-muted" />}
    >
      <Activity params={params} />
    </Suspense>
  )
}
