import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import { StatusPill } from '@/components/common/status-pill'
import {
  AdminPage,
  EmptyState,
  ErrorState,
  FilterLinks,
  LINK,
  Pager,
  PageSkeleton,
  TableBox,
  TD,
  TH,
} from '@/features/admin/components/parts'
import { domainStatusOf, formatCount, formatWhen } from '@/features/admin/lib/format'
import { domainStatusFilterOf, listHref, pageOf } from '@/features/admin/lib/params'
import { DOMAIN_STATUSES } from '@/features/admin/lib/states'
import { getDomains, PAGE_SIZE } from '@/features/admin/queries/mail'
import { requireAdmin } from '@/features/admin/queries/session'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Domains' }

type Params = Promise<Record<string, string | string[] | undefined>>

/** §10: every account's sending domains, by status. */
async function Domains({ searchParams }: { searchParams: Params }) {
  await requireAdmin()
  const params = await searchParams
  const status = domainStatusFilterOf(params)
  const page = pageOf(params)
  const read = await getDomains({ status, query: null, page })
  const here = (next: Record<string, string | number | null>) =>
    listHref('/admin/domains', { status, page, ...next })

  return (
    <AdminPage title="Domains" intro="The domains accounts send from, and where SES has them.">
      <FilterLinks
        label="Filter by status"
        options={[
          { href: here({ status: null, page: 1 }), label: 'All', current: status === null },
          ...DOMAIN_STATUSES.map((value) => ({
            href: here({ status: value, page: 1 }),
            label: domainStatusOf(value).label,
            current: status === value,
          })),
        ]}
      />
      {!read.ok ? (
        <ErrorState code={read.code} retryHref={here({})} />
      ) : read.data.rows.length === 0 ? (
        <EmptyState
          title="No domain matches"
          body={status ? 'Try another status.' : 'No account has added a domain yet.'}
        />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {formatCount(read.data.total)} {read.data.total === 1 ? 'domain' : 'domains'}
          </p>
          <TableBox label="Domains">
            <table className="w-full min-w-[48rem] border-collapse">
              <thead className="border-b border-border">
                <tr>
                  <th scope="col" className={TH}>
                    Domain
                  </th>
                  <th scope="col" className={TH}>
                    Status
                  </th>
                  <th scope="col" className={TH}>
                    Account
                  </th>
                  <th scope="col" className={TH}>
                    Verified
                  </th>
                  <th scope="col" className={TH}>
                    Last checked
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {read.data.rows.map((row) => {
                  const s = domainStatusOf(row.status)
                  return (
                    <tr key={row.id}>
                      <th
                        scope="row"
                        className={cn(TD, 'text-left font-mono font-normal break-all')}
                      >
                        {row.name}
                      </th>
                      <td className={TD}>
                        <StatusPill tone={s.tone}>{s.label}</StatusPill>
                        {row.failedReason ? (
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {row.failedReason}
                          </span>
                        ) : null}
                      </td>
                      <td className={TD}>
                        <Link href={`/admin/accounts/${row.accountId}`} className={LINK}>
                          {row.accountName}
                        </Link>
                        <span className="block font-mono text-xs text-muted-foreground">
                          {row.accountTenant}
                        </span>
                      </td>
                      <td className={cn(TD, 'whitespace-nowrap')}>{formatWhen(row.verifiedAt)}</td>
                      <td className={cn(TD, 'whitespace-nowrap')}>
                        {formatWhen(row.lastCheckedAt)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableBox>
          <Pager
            page={page}
            total={read.data.total}
            pageSize={PAGE_SIZE}
            hrefFor={(next) => here({ page: next })}
          />
        </>
      )}
    </AdminPage>
  )
}

export default function DomainsPage({ searchParams }: { searchParams: Params }) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Domains searchParams={searchParams} />
    </Suspense>
  )
}
