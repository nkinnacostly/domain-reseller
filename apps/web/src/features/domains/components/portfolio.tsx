import Link from 'next/link'
import { DomainStatusPill } from '@/components/common/domain-status-pill'
import { cn } from '@/lib/utils'
import {
  DELEGATION_LABEL,
  daysUntilExpiry,
  EXPIRY_WINDOWS,
  type ExpiryWindow,
  filterPortfolio,
  type PortfolioDomain,
} from '../lib/portfolio'
import { DomainBadges } from './domain-badges'

const dateFormat = new Intl.DateTimeFormat('en-NG', {
  dateStyle: 'medium',
  timeZone: 'Africa/Lagos',
})

function windowHref(query: string, within: ExpiryWindow | null) {
  const params = new URLSearchParams()
  if (query) params.set('q', query)
  if (within) params.set('within', String(within))
  const search = params.toString()
  return search ? `/app/domains?${search}` : '/app/domains'
}

/** FR-P2 table and FR-P5 expiry view in one: the view is a filter, not a separate page. */
export function Portfolio({
  domains,
  query,
  within,
}: {
  domains: PortfolioDomain[]
  query: string
  within: ExpiryWindow | null
}) {
  const now = new Date()
  const shown = filterPortfolio(domains, { query, expiringWithin: within }, now)

  return (
    <section aria-labelledby="portfolio-heading" className="mt-8">
      <h2 id="portfolio-heading" className="sr-only">
        Your domains
      </h2>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <search className="w-full sm:max-w-xs">
          <form action="/app/domains" method="get">
            <label htmlFor="portfolio-search" className="sr-only">
              Search your domains
            </label>
            {within ? <input type="hidden" name="within" value={within} /> : null}
            <input
              id="portfolio-search"
              name="q"
              type="search"
              defaultValue={query}
              placeholder="Search your domains"
              className="h-11 w-full rounded-full border border-input bg-background px-4 text-base outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:text-sm"
            />
          </form>
        </search>

        <nav aria-label="Expiry" className="flex flex-wrap gap-2 text-sm">
          {[null, ...EXPIRY_WINDOWS].map((option) => {
            const current = option === within
            return (
              <Link
                key={option ?? 'all'}
                href={windowHref(query, option)}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'inline-flex h-9 items-center rounded-full border px-3.5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                  current
                    ? 'border-foreground bg-foreground font-medium text-background'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {option ? `Expiring in ${option} days` : 'All'}
              </Link>
            )
          })}
        </nav>
      </div>

      {shown.length === 0 ? (
        <p className="mt-6 rounded-2xl border border-border border-dashed px-6 py-10 text-center text-muted-foreground">
          {within
            ? `Nothing expires in the next ${within} days.`
            : 'No domain matches that search.'}
        </p>
      ) : (
        <>
          {/* Phones: one card per domain. The table needs more width than a phone has. */}
          <ul aria-label="Your domains" className="mt-6 space-y-3 md:hidden">
            {shown.map((domain) => {
              const days = daysUntilExpiry(domain.expiresAt, now)
              return (
                <li key={domain.id}>
                  <Link
                    href={`/app/domains/${domain.domainName}`}
                    data-domain={domain.domainName}
                    className="block rounded-2xl border border-border p-4 transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold break-all text-foreground">
                        {domain.domainName}
                      </span>
                      <DomainBadges source={domain.source} testMode={domain.testMode} />
                    </span>
                    <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted-foreground">
                      <DomainStatusPill
                        status={domain.status}
                        daysUntilExpiry={days ?? undefined}
                      />
                      <span>
                        {domain.expiresAt
                          ? `Expires ${dateFormat.format(new Date(domain.expiresAt))}`
                          : 'Expires a year after registration'}
                      </span>
                    </span>
                    <span className="mt-1.5 block text-sm text-muted-foreground">
                      Auto-renew {domain.autoRenew ? 'on' : 'off'} ·{' '}
                      {domain.pendingNameservers
                        ? 'Change waiting'
                        : DELEGATION_LABEL[domain.delegationStatus]}
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>

          <div className="relative mt-6 hidden overflow-x-auto rounded-2xl border border-border md:block">
            <table className="w-full min-w-[44rem] border-collapse text-sm">
              <caption className="sr-only">
                Your domains, soonest expiry first, with status, auto-renew and where each is
                pointed
              </caption>
              <thead>
                <tr className="border-border border-b text-left text-muted-foreground">
                  <th scope="col" className="px-4 py-3 font-medium">
                    Domain
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Expires
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Auto-renew
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Nameservers
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((domain) => {
                  const days = daysUntilExpiry(domain.expiresAt, now)
                  return (
                    <tr
                      key={domain.id}
                      className="border-border/60 border-b transition-colors last:border-b-0 focus-within:bg-muted/50 hover:bg-muted/50"
                    >
                      <th scope="row" className="px-4 py-3 text-left font-medium">
                        <Link
                          href={`/app/domains/${domain.domainName}`}
                          data-domain={domain.domainName}
                          className="text-foreground underline-offset-4 hover:underline focus-visible:rounded focus-visible:outline-2 focus-visible:outline-ring"
                        >
                          {domain.domainName}
                        </Link>
                        <DomainBadges
                          source={domain.source}
                          testMode={domain.testMode}
                          className="ml-2"
                        />
                      </th>
                      <td className="px-4 py-3">
                        <DomainStatusPill
                          status={domain.status}
                          daysUntilExpiry={days ?? undefined}
                        />
                      </td>
                      <td className="px-4 py-3 text-muted-foreground tabular-nums">
                        {domain.expiresAt ? (
                          <>
                            {dateFormat.format(new Date(domain.expiresAt))}
                            <span className="block text-xs">
                              {days !== null && days < 0 ? `${-days} days ago` : `in ${days} days`}
                            </span>
                          </>
                        ) : (
                          'After registration'
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {domain.autoRenew ? 'On' : 'Off'}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {domain.pendingNameservers
                          ? 'Change waiting'
                          : DELEGATION_LABEL[domain.delegationStatus]}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}
