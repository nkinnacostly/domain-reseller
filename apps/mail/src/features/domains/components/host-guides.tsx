import { ExternalLink } from 'lucide-react'
import { HOST_GUIDES } from '../lib/hosts'

const checked = new Intl.DateTimeFormat('en-NG', { dateStyle: 'long', timeZone: 'Africa/Lagos' })

/**
 * Where to add the records at the hosts our customers use most (MAIL-SPEC
 * §6 "DNS set-up per host"), each from the host's own pages, named and dated.
 * Native disclosure, so every answer is in the page with or without script.
 */
export function HostGuides() {
  return (
    <div className="space-y-3">
      {HOST_GUIDES.map((guide) => (
        <details
          key={guide.id}
          className="group rounded-2xl border border-border bg-card open:pb-4 [&_summary::-webkit-details-marker]:hidden"
        >
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-4 py-3 font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            {guide.name}
            <span
              aria-hidden="true"
              className="text-muted-foreground transition group-open:rotate-45"
            >
              +
            </span>
          </summary>
          <div className="space-y-3 px-4 text-pretty text-sm/6">
            <ol className="list-decimal space-y-1.5 pl-5">
              {guide.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <ul className="list-disc space-y-1.5 pl-5 text-muted-foreground">
              {guide.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
            <p className="text-xs/5 text-muted-foreground">
              From {guide.name}’s own pages, read on {checked.format(new Date(guide.checkedOn))}:{' '}
              {guide.sources.map((source, index) => (
                <span key={source.url}>
                  {index > 0 ? ', ' : ''}
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-sm font-medium text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {source.title}
                    <ExternalLink className="size-3" aria-hidden="true" />
                    <span className="sr-only">(opens in a new tab)</span>
                  </a>
                </span>
              ))}
              .
            </p>
          </div>
        </details>
      ))}
      <p className="text-pretty text-sm/6 text-muted-foreground">
        Another host? Look for its DNS records or zone editor. Most add your domain to the name you
        type, so type only the part before it, as shown under each record’s name.
      </p>
    </div>
  )
}
