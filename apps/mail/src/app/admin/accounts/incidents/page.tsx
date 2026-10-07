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
import {
  formatCount,
  formatWhen,
  INCIDENT_CLOSING,
  incidentFacts,
  incidentKindOf,
} from '@/features/admin/lib/format'
import { incidentShowOf, listHref, pageOf } from '@/features/admin/lib/params'
import { getBillingIncidents, PAGE_SIZE } from '@/features/admin/queries/mail'
import { requireAdmin } from '@/features/admin/queries/session'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Billing incidents' }

type Params = Promise<Record<string, string | string[] | undefined>>

const SHOW = [
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'all', label: 'All' },
] as const

/**
 * Billing incidents (MAIL-SPEC §8, §10; migrations 54, 56), read-only:
 * charges that need a person in Flutterwave — a refund, a cancel, a payment
 * not recorded. Each open live one is also an ops alert. Nothing here changes
 * money: the incident says what to do, and it is done in Flutterwave. There
 * is no resolve action yet, so the page says how one is closed.
 */
async function Incidents({ searchParams }: { searchParams: Params }) {
  const admin = await requireAdmin()
  const params = await searchParams
  const show = incidentShowOf(params)
  const page = pageOf(params)
  const read = await getBillingIncidents({ show, page })
  const here = (next: Record<string, string | number | null>) =>
    listHref('/admin/accounts/incidents', { show: show === 'open' ? null : show, page, ...next })

  return (
    <AdminPage
      title="Billing incidents"
      intro={
        admin.testOnly
          ? 'Test payments that need a person. Live incidents are not shown to you.'
          : 'Charges that need a person in Flutterwave: a refund, a cancelled subscription, a payment to record. Open live ones are also sent as ops alerts.'
      }
    >
      <FilterLinks
        label="Show"
        options={SHOW.map((option) => ({
          href: here({ show: option.value === 'open' ? null : option.value, page: 1 }),
          label: option.label,
          current: show === option.value,
        }))}
      />
      {!read.ok ? (
        <ErrorState code={read.code} retryHref={here({})} />
      ) : read.data.rows.length === 0 ? (
        <EmptyState
          title={show === 'open' ? 'No open incidents' : 'No incidents'}
          body={
            show === 'open'
              ? 'Nothing needs a person right now.'
              : 'Billing incidents appear here when a charge needs a person.'
          }
        />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {formatCount(read.data.total)} {read.data.total === 1 ? 'incident' : 'incidents'}
            {show !== 'open' ? `, ${formatCount(read.data.open)} open` : ''}
          </p>
          <p className="max-w-3xl text-pretty text-sm text-muted-foreground" data-incident-closing>
            {INCIDENT_CLOSING}
          </p>
          <TableBox label="Billing incidents">
            <table className="w-full min-w-[56rem] border-collapse">
              <thead className="border-b border-border">
                <tr>
                  <th scope="col" className={TH}>
                    When
                  </th>
                  <th scope="col" className={TH}>
                    Incident
                  </th>
                  <th scope="col" className={TH}>
                    Account
                  </th>
                  <th scope="col" className={TH}>
                    Flutterwave
                  </th>
                  <th scope="col" className={TH}>
                    State
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {read.data.rows.map((row) => {
                  const kind = incidentKindOf(row.kind)
                  const detail = incidentFacts(row.kind, row.detail, row.providerReference)
                  return (
                    <tr key={row.id} data-incident={row.id}>
                      <td className={cn(TD, 'whitespace-nowrap')}>
                        {formatWhen(row.createdAt)}
                        {row.testMode ? (
                          <span className="block text-xs text-muted-foreground">Test payment</span>
                        ) : null}
                      </td>
                      <td className={cn(TD, 'max-w-96')}>
                        <span className="font-medium">{kind.label}</span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {kind.todo}
                        </span>
                        {detail ? (
                          <span className="mt-1 block text-xs text-muted-foreground">{detail}</span>
                        ) : null}
                      </td>
                      <td className={TD}>
                        {row.accountId ? (
                          <Link href={`/admin/accounts/${row.accountId}`} className={LINK}>
                            {row.accountName ?? row.tenant ?? row.accountId.slice(0, 8)}
                            <span className="sr-only">, open the account</span>
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">No account</span>
                        )}
                        {row.tenant ? (
                          <span className="block font-mono text-xs text-muted-foreground">
                            {row.tenant}
                          </span>
                        ) : null}
                      </td>
                      <td className={cn(TD, 'font-mono text-xs')}>
                        {row.providerReference ?? '—'}
                      </td>
                      <td className={TD}>
                        {row.resolvedAt ? (
                          <>
                            <StatusPill tone="success">Resolved</StatusPill>
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {formatWhen(row.resolvedAt)}
                              {row.resolvedBy ? `, ${row.resolvedBy}` : ''}
                            </span>
                          </>
                        ) : (
                          <StatusPill tone="danger">Open</StatusPill>
                        )}
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

export default function IncidentsPage({ searchParams }: { searchParams: Params }) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Incidents searchParams={searchParams} />
    </Suspense>
  )
}
