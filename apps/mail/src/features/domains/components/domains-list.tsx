import { ChevronRight } from 'lucide-react'
import Link from 'next/link'
import { formatWhen } from '../lib/status'
import type { Domain } from '../queries/domains'
import { DomainStatusPill } from './domain-status'

/**
 * The account's domains (MAIL-SPEC §10: "each domain's state"), newest first,
 * each linking to its records and checks. Rows are found by `data-domain`.
 */
export function DomainsList({ domains }: { domains: Domain[] }) {
  return (
    <ul className="divide-y divide-border rounded-3xl border border-border bg-card">
      {domains.map((domain) => {
        const note =
          domain.status === 'verified'
            ? `Verified ${formatWhen(domain.verifiedAt) ?? ''}`.trim()
            : domain.status === 'pending' && domain.deadline
              ? `To verify by ${formatWhen(domain.deadline)}`
              : domain.status === 'failed'
                ? 'Not verified in time'
                : `Added ${formatWhen(domain.createdAt)}`
        return (
          <li key={domain.id} data-domain={domain.name}>
            <Link
              href={`/dashboard/domains/${domain.id}`}
              className="flex min-h-16 items-center gap-3 rounded-3xl px-4 py-3 transition hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring active:bg-muted sm:px-5"
            >
              <span className="min-w-0 flex-1">
                <span className="block font-medium break-all">{domain.unicode ?? domain.name}</span>
                {domain.unicode ? (
                  <span className="block text-xs break-all text-muted-foreground">
                    {domain.name}
                  </span>
                ) : null}
                <span className="mt-0.5 block text-sm text-muted-foreground">{note}</span>
              </span>
              <DomainStatusPill status={domain.status} settingUp={domain.settingUp} />
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
