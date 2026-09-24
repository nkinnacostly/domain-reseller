import { ArrowRight } from 'lucide-react'
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
import { transferExpiryText } from '../lib/registration'
import { PANEL } from './dashboard/panel'
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
    <section
      id="portfolio"
      aria-labelledby="portfolio-heading"
      className={cn(PANEL, 'scroll-mt-20 p-4 sm:p-5')}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 id="portfolio-heading" className="font-medium text-foreground">
          Your domains
        </h2>

        {domains.length > 0 ? (
          <search className="w-full sm:w-64">
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
                className="h-10 w-full rounded-full border border-input bg-background px-4 text-base outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:text-sm"
              />
            </form>
          </search>
        ) : null}
      </div>

      {domains.length > 0 ? (
        <nav aria-label="Expiry" className="mt-3 flex flex-wrap gap-2 text-sm">
          {[null, ...EXPIRY_WINDOWS].map((option) => {
            const current = option === within
            return (
              <Link
                key={option ?? 'all'}
                href={windowHref(query, option)}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'inline-flex h-9 items-center rounded-full border px-3.5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]',
                  current
                    ? 'border-brand bg-brand font-medium text-brand-foreground'
                    : 'border-border bg-background text-muted-foreground hover:text-foreground',
                )}
              >
                {option ? `Expiring in ${option} days` : 'All'}
              </Link>
            )
          })}
        </nav>
      ) : null}

      {domains.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-border border-dashed px-6 py-12 text-center sm:py-16">
          <h3 className="text-lg font-semibold text-foreground">No domains yet</h3>
          <p className="mx-auto mt-2 max-w-md text-pretty text-sm/6 text-muted-foreground">
            Domains you register or transfer in will appear here, each with its renewal date and
            price.
          </p>
          <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/search"
              className="inline-flex h-11 items-center gap-2 rounded-full bg-accent px-6 text-sm font-medium text-accent-foreground transition hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
            >
              Search for a domain
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
            <Link
              href="/transfer"
              className="inline-flex h-11 items-center rounded-full border border-border bg-background px-6 text-sm font-medium text-foreground transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
            >
              Transfer one in
            </Link>
          </div>
        </div>
      ) : null}

      {domains.length === 0 ? null : shown.length === 0 ? (
        <p className="mt-4 rounded-2xl border border-border border-dashed px-6 py-10 text-center text-muted-foreground">
          {within
            ? `Nothing expires in the next ${within} days.`
            : 'No domain matches that search.'}
        </p>
      ) : (
        <>
          {/* One card per domain until the table has room beside the sidebar. */}
          <ul aria-label="Your domains" className="mt-4 space-y-3 xl:hidden">
            {shown.map((domain) => {
              const days = daysUntilExpiry(domain.expiresAt, now)
              return (
                <li key={domain.id}>
                  <Link
                    href={`/app/domains/${domain.domainName}`}
                    data-domain={domain.domainName}
                    className="block rounded-2xl border border-border bg-background/80 p-4 transition-colors hover:bg-brand-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
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
                          : (transferExpiryText(domain) ?? 'Expires a year after registration')}
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

          <div className="relative mt-4 hidden overflow-x-auto xl:block">
            <table className="w-full min-w-[44rem] border-collapse text-sm">
              <caption className="sr-only">
                Your domains, soonest expiry first, with status, auto-renew and where each is
                pointed
              </caption>
              <thead>
                <tr className="bg-muted/70 text-left text-muted-foreground [&>th:first-child]:rounded-l-xl [&>th:last-child]:rounded-r-xl">
                  <th scope="col" className="px-4 py-3 text-xs font-medium tracking-wide uppercase">
                    Domain
                  </th>
                  <th scope="col" className="px-4 py-3 text-xs font-medium tracking-wide uppercase">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-3 text-xs font-medium tracking-wide uppercase">
                    Expires
                  </th>
                  <th scope="col" className="px-4 py-3 text-xs font-medium tracking-wide uppercase">
                    Auto-renew
                  </th>
                  <th scope="col" className="px-4 py-3 text-xs font-medium tracking-wide uppercase">
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
                      className="border-border/60 border-b transition-colors last:border-b-0 focus-within:bg-brand-subtle hover:bg-brand-subtle"
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
                          (transferExpiryText(domain) ?? 'After registration')
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
