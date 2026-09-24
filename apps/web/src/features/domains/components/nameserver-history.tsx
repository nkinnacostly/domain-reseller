import { ArrowRight } from 'lucide-react'
import type { ChangeSource, HistoryEntry } from '../lib/nameserver-history'

const timeFormat = new Intl.DateTimeFormat('en-NG', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Africa/Lagos',
})

/** Who made a change, as far as the activity log says (FR-N5). */
export function sourceText(source: ChangeSource): string {
  switch (source.kind) {
    case 'request': {
      const who = source.by === 'you' ? 'you' : source.by === 'support' ? 'our support team' : 'us'
      return `Asked for by ${who} on ${timeFormat.format(new Date(source.requestedAt))}`
    }
    case 'registry':
      return 'Found at the registry — changed outside this panel'
    case 'first':
      return 'The first set on record for this domain'
    case 'unknown':
      return 'Recorded from the registry'
  }
}

const Hosts = ({ hosts }: { hosts: readonly string[] }) => (
  <span className="font-mono text-xs break-all text-foreground">{hosts.join(', ')}</span>
)

/**
 * FR-N5 — every change of the domain's nameservers, newest first: before and
 * after, when it took effect, and who asked where we know.
 */
export function NameserverHistory({ entries }: { entries: readonly HistoryEntry[] }) {
  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No changes yet. Each change is listed here once it takes effect, with the set it replaced.
      </p>
    )
  }
  return (
    <ol aria-label="Nameserver changes" className="space-y-2">
      {entries.map((entry) => (
        <li
          key={`${entry.changedAt}-${entry.after.join(',')}`}
          className="relative rounded-2xl border border-border bg-background/80 px-4 py-3 text-sm sm:px-5"
        >
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {entry.before?.length ? (
              <>
                <span className="sr-only">From </span>
                <Hosts hosts={entry.before} />
                <ArrowRight
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="sr-only"> to </span>
              </>
            ) : null}
            <Hosts hosts={entry.after} />
          </p>
          <p className="mt-1 text-muted-foreground">
            <time dateTime={entry.changedAt}>{timeFormat.format(new Date(entry.changedAt))}</time> ·{' '}
            {sourceText(entry.source)}
          </p>
        </li>
      ))}
    </ol>
  )
}
