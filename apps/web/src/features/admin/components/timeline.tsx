import { formatWat } from '@/features/admin/lib/format'
import { TONE_CLASS, type Tone } from '@/features/admin/lib/tone'
import { cn } from '@/lib/utils'

export type TimelineEvent = {
  id: string
  at: string
  title: string
  detail?: React.ReactNode
  tone?: Tone
}

/** What happened, newest first, each with its time in WAT. */
export function Timeline({
  events,
  empty = 'Nothing has happened yet.',
}: {
  events: TimelineEvent[]
  empty?: string
}) {
  if (events.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>
  return (
    <ol className="space-y-4">
      {events.map((event) => (
        <li key={event.id} className="relative flex gap-3">
          <span
            aria-hidden="true"
            className={cn(
              'mt-1.5 size-2.5 shrink-0 rounded-full border bg-(--dot)',
              TONE_CLASS[event.tone ?? 'neutral'],
            )}
          />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{event.title}</p>
            <p className="text-xs text-muted-foreground">
              <time dateTime={event.at}>{formatWat(event.at)}</time>
            </p>
            {event.detail ? (
              <div className="mt-1 text-sm break-words text-muted-foreground">{event.detail}</div>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  )
}
