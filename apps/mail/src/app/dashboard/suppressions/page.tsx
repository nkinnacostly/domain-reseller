import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import { inputClass } from '@/components/common/form-parts'
import { StatusPill } from '@/components/common/status-pill'
import { Container } from '@/components/layout/container'
import { PageSkeleton } from '@/features/accounts/components/dashboard-skeleton'
import { PartError } from '@/features/accounts/components/overview-parts'
import { getCurrentAccount } from '@/features/accounts/queries/accounts'
import { ImportSuppressions } from '@/features/suppressions/components/import-suppressions'
import { RemoveSuppression } from '@/features/suppressions/components/remove-suppression'
import {
  canImportSuppressions,
  canRemoveSuppressions,
  REASON,
  SOURCE,
} from '@/features/suppressions/lib/words'
import {
  getSuppressions,
  SUPPRESSIONS_PAGE_SIZE,
  searchTerm,
} from '@/features/suppressions/queries/suppressions'

export const metadata: Metadata = { title: 'Suppressions' }

type Params = Promise<{ q?: string; page?: string }>

const PAGE = '/dashboard/suppressions'

const when = new Intl.DateTimeFormat('en-NG', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Africa/Lagos',
})

const pageLink =
  'inline-flex min-h-11 items-center rounded-full border border-border bg-background px-5 text-sm font-medium transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]'

/**
 * Suppressions (MAIL-SPEC §7.5, §10): the addresses this account will not
 * send to, why and when each was added, and — for owners and admins — a way
 * to remove one, with a warning, and to import another provider's list
 * (migration 68). Shown to the account's members only (MR4).
 */
async function Suppressions({ searchParams }: { searchParams: Params }) {
  const [data, params] = await Promise.all([getCurrentAccount(), searchParams])
  if (!data) return null
  const { account, role } = data.current
  const search = searchTerm(params.q)
  const page = Math.max(1, Math.min(10_000, Number.parseInt(params.page ?? '1', 10) || 1))
  const list = await getSuppressions(account.id, { page, search })
  const remove = canRemoveSuppressions(role)
  const canImport = canImportSuppressions(role)
  const pages = list ? Math.max(1, Math.ceil(list.total / SUPPRESSIONS_PAGE_SIZE)) : 1
  const href = (n: number) => `${PAGE}?page=${n}`

  return (
    <div className="space-y-6">
      {canImport ? <ImportSuppressions accountId={account.id} /> : null}
      <search aria-label="Find an address" className="block max-w-xl">
        <form method="get" action={PAGE}>
          <label htmlFor="suppression-search" className="text-sm font-medium">
            Find an address
          </label>
          <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
            <input
              id="suppression-search"
              name="q"
              type="search"
              inputMode="email"
              autoComplete="off"
              spellCheck={false}
              defaultValue={search ?? ''}
              placeholder="name@example.com"
              className={inputClass}
            />
            <button
              type="submit"
              className="inline-flex h-11 shrink-0 items-center justify-center rounded-full bg-primary px-6 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
            >
              Find
            </button>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">The whole address, exactly.</p>
        </form>
      </search>

      {!list ? (
        <PartError what="the suppression list" retryHref={PAGE} />
      ) : list.rows.length === 0 ? (
        <div className="space-y-3">
          <p className="text-pretty text-sm text-muted-foreground">
            {search
              ? 'That address is not on the list: this account can send to it.'
              : list.total > 0
                ? 'There is nothing on this page.'
                : `No addresses are suppressed. When one hard-bounces or marks an email as spam, it appears here and nothing more is sent to it.${canImport ? ' Moving from another provider? Import its list above.' : ''}`}
          </p>
          {search || list.total > 0 ? (
            <Link href={PAGE} className={pageLink}>
              Show the whole list
            </Link>
          ) : null}
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground" role="status">
            {search
              ? 'Found on the list.'
              : `${list.total.toLocaleString('en-NG')} ${list.total === 1 ? 'address' : 'addresses'}, newest first, in Lagos time.`}
          </p>
          <ul className="divide-y divide-border rounded-3xl border border-border bg-card">
            {list.rows.map((row) => (
              <li
                key={row.id}
                data-suppression={row.address}
                className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 space-y-1">
                  <p className="break-all font-medium">{row.address}</p>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                    <StatusPill tone={REASON[row.reason].tone}>
                      {REASON[row.reason].label}
                    </StatusPill>
                    <span>
                      {when.format(new Date(row.createdAt))} · from {SOURCE[row.source]}
                    </span>
                  </div>
                  <p className="text-pretty text-xs text-muted-foreground">
                    {REASON[row.reason].why}
                  </p>
                </div>
                {remove ? (
                  <RemoveSuppression
                    accountId={account.id}
                    suppressionId={row.id}
                    address={row.address}
                    reason={row.reason}
                  />
                ) : null}
              </li>
            ))}
          </ul>
          {!search && pages > 1 ? (
            <nav aria-label="Pages of the list" className="flex flex-wrap items-center gap-3">
              {page > 1 ? (
                <Link href={href(page - 1)} className={pageLink} rel="prev">
                  Newer
                </Link>
              ) : null}
              <p className="text-sm text-muted-foreground">
                Page {page} of {pages}
              </p>
              {page < pages ? (
                <Link href={href(page + 1)} className={pageLink} rel="next">
                  Older
                </Link>
              ) : null}
            </nav>
          ) : null}
        </>
      )}
      {!remove ? (
        <p className="max-w-2xl text-pretty text-xs text-muted-foreground">
          Only the account’s owner or an admin can import a list or remove an address from it.
        </p>
      ) : null}
    </div>
  )
}

export default function SuppressionsPage({ searchParams }: { searchParams: Params }) {
  return (
    <Container className="py-6 sm:py-8">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Suppressions</h1>
      <p className="mt-2 max-w-3xl text-pretty text-sm/6 text-muted-foreground">
        Addresses this account will not send to. A hard bounce or a spam complaint puts an address
        here, and on Amazon SES’s list for this account; so can you, by importing another provider’s
        list. An email to an address here is refused before it costs anything.
      </p>
      <div className="mt-8">
        <Suspense fallback={<PageSkeleton />}>
          <Suppressions searchParams={searchParams} />
        </Suspense>
      </div>
    </Container>
  )
}
