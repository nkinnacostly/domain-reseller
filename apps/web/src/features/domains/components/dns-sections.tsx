import { CircleCheck, CircleDashed, CircleX } from 'lucide-react'
import { sameNameservers } from '../lib/nameserver-check'
import { delegationViews, inspectDns } from '../queries/dns'

/**
 * FR-D6 — what each big public resolver sees right now. Live, not cached:
 * someone checking whether their change has landed wants this minute's answer.
 */
export async function ResolverViews({
  domain,
  expected,
}: {
  domain: string
  expected: string[] | null
}) {
  const views = await delegationViews(domain)
  return (
    <ul
      aria-label="What public resolvers see"
      className="divide-y divide-border/70 rounded-2xl border border-border"
    >
      {views.map((view) => {
        const matches =
          view.state === 'answered' && expected ? sameNameservers(view.nameservers, expected) : null
        const Icon =
          view.state !== 'answered' ? CircleDashed : matches === false ? CircleX : CircleCheck
        return (
          <li
            key={view.resolver}
            className="flex flex-col gap-1 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
          >
            <span className="flex items-center gap-2 font-medium text-foreground">
              <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
              {view.resolver}
            </span>
            <span className="font-mono text-xs text-pretty break-words text-muted-foreground sm:text-right">
              {view.state === 'answered'
                ? view.nameservers.join(', ')
                : view.state === 'nxdomain'
                  ? 'Not in DNS yet — no nameservers answer for this name'
                  : 'No answer just now'}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/** FR-N4 — the records anyone looking this domain up gets. Read-only: we do not host the zone. */
export async function DnsRecords({ domain }: { domain: string }) {
  const records = await inspectDns(domain)
  if (!records.exists) {
    return (
      <p className="rounded-2xl border border-border border-dashed px-5 py-6 text-sm text-muted-foreground">
        {domain} has no DNS records yet. Once it is registered and pointed at your host, they will
        show here.
      </p>
    )
  }

  const rows: [string, string[], string][] = [
    ['A', records.a, 'Website address (IPv4)'],
    ['AAAA', records.aaaa, 'Website address (IPv6)'],
    ['CNAME', records.cname, 'Alias'],
    ['MX', records.mx.map((mx) => `${mx.priority} ${mx.exchange}`), 'Email'],
    ['TXT', records.txt, 'Verification and email security'],
    ['CAA', records.caa, 'Who may issue certificates'],
  ]
  return (
    <div className="relative overflow-x-auto rounded-2xl border border-border">
      <table className="w-full min-w-[32rem] border-collapse text-sm">
        <caption className="sr-only">
          DNS records for {domain}, as a public resolver sees them
        </caption>
        <thead>
          <tr className="border-border border-b text-left text-muted-foreground">
            <th scope="col" className="px-4 py-2.5 font-medium">
              Type
            </th>
            <th scope="col" className="px-4 py-2.5 font-medium">
              Records
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([type, values, meaning]) => (
            <tr key={type} className="border-border/60 border-b align-top last:border-b-0">
              <th scope="row" className="px-4 py-2.5 text-left font-medium">
                {type}
                <span className="block text-xs font-normal text-muted-foreground">{meaning}</span>
              </th>
              <td className="px-4 py-2.5 font-mono text-xs break-all text-foreground">
                {values.length ? (
                  values.join('\n')
                ) : (
                  <span className="font-sans text-muted-foreground">None</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** For FR-N6's warning: a one-line summary of what the current provider serves. */
export async function currentRecordSummary(domain: string): Promise<string[]> {
  const records = await inspectDns(domain)
  const summary: string[] = []
  if (records.a.length || records.aaaa.length) summary.push('a website address')
  if (records.mx.length)
    summary.push(`email (${records.mx.length} MX record${records.mx.length === 1 ? '' : 's'})`)
  if (records.txt.length)
    summary.push(`${records.txt.length} TXT record${records.txt.length === 1 ? '' : 's'}`)
  return summary
}

export function DnsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="animate-pulse space-y-2">
      {Array.from({ length: rows }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <div key={index} className="h-11 rounded-xl bg-muted" />
      ))}
    </div>
  )
}
