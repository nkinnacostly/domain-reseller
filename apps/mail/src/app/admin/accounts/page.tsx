import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import { inputClass } from '@/components/common/form-parts'
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
  sesStatusOf,
  stateOf,
  stateReasonOf,
} from '@/features/admin/lib/format'
import { accountStateOf, listHref, pageOf, tenantQueryOf } from '@/features/admin/lib/params'
import { ACCOUNT_STATES } from '@/features/admin/lib/states'
import { getAccounts, PAGE_SIZE } from '@/features/admin/queries/mail'
import { requireAdmin } from '@/features/admin/queries/session'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Accounts' }

type Params = Promise<Record<string, string | string[] | undefined>>

/** §10: every account — its plan, state, SES status, today's and this month's sends, findings. */
async function Accounts({ searchParams }: { searchParams: Params }) {
  await requireAdmin()
  const params = await searchParams
  const state = accountStateOf(params)
  const query = tenantQueryOf(params)
  const page = pageOf(params)
  const read = await getAccounts({ state, query, page })
  const here = (next: Record<string, string | number | null>) =>
    listHref('/admin/accounts', { state, q: query, page, ...next })

  return (
    <AdminPage
      title="Accounts"
      intro="Each account’s plan, state, SES tenant, sends and open findings."
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <FilterLinks
          label="Filter by state"
          options={[
            { href: here({ state: null, page: 1 }), label: 'All', current: state === null },
            ...ACCOUNT_STATES.map((value) => ({
              href: here({ state: value, page: 1 }),
              label: stateOf(value).label,
              current: state === value,
            })),
          ]}
        />
        <search>
          <form method="get" action="/admin/accounts" className="flex flex-wrap items-end gap-2">
            {state ? <input type="hidden" name="state" value={state} /> : null}
            <div>
              <label htmlFor="tenant-search" className="text-sm font-medium">
                Tenant or account id
              </label>
              <input
                id="tenant-search"
                name="q"
                defaultValue={query ?? ''}
                placeholder="mdm-0123456789"
                autoComplete="off"
                spellCheck={false}
                className={cn(inputClass, 'mt-1.5 w-56 font-mono')}
              />
            </div>
            <button
              type="submit"
              className="inline-flex min-h-11 items-center rounded-full border border-border px-4 text-sm font-medium transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
            >
              Find
            </button>
          </form>
        </search>
      </div>
      {!read.ok ? (
        <ErrorState code={read.code} retryHref={here({})} />
      ) : read.data.rows.length === 0 ? (
        <EmptyState
          title="No account matches"
          body={
            query || state
              ? 'Try another state, or clear the search.'
              : 'No one has made a Mail account yet.'
          }
        />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {formatCount(read.data.total)} {read.data.total === 1 ? 'account' : 'accounts'}
          </p>
          <TableBox label="Accounts">
            <table className="w-full min-w-[56rem] border-collapse">
              <thead className="border-b border-border">
                <tr>
                  <th scope="col" className={TH}>
                    Account
                  </th>
                  <th scope="col" className={TH}>
                    State
                  </th>
                  <th scope="col" className={TH}>
                    SES
                  </th>
                  <th scope="col" className={TH}>
                    Plan
                  </th>
                  <th scope="col" className={TH}>
                    Today
                  </th>
                  <th scope="col" className={TH}>
                    This month
                  </th>
                  <th scope="col" className={TH}>
                    Open findings
                  </th>
                  <th scope="col" className={TH}>
                    Since
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {read.data.rows.map((row) => {
                  const st = stateOf(row.state)
                  const ses = sesStatusOf(row.sesStatus)
                  const reason = stateReasonOf(row.stateReason)
                  return (
                    <tr key={row.id} data-account={row.id}>
                      <th scope="row" className={cn(TD, 'text-left font-normal')}>
                        <Link href={`/admin/accounts/${row.id}`} className={LINK}>
                          {row.name}
                        </Link>
                        <span className="block font-mono text-xs text-muted-foreground">
                          {row.tenant}
                        </span>
                      </th>
                      <td className={TD}>
                        <StatusPill tone={st.tone}>{st.label}</StatusPill>
                        {reason ? (
                          <span className="mt-1 block text-xs text-muted-foreground">{reason}</span>
                        ) : null}
                      </td>
                      <td className={TD}>
                        <StatusPill tone={ses.tone}>{ses.label}</StatusPill>
                      </td>
                      <td className={TD}>{row.planCode}</td>
                      <td className={cn(TD, 'tabular-nums')}>
                        {formatCount(row.today)} / {formatCount(row.caps.daily)}
                      </td>
                      <td className={cn(TD, 'tabular-nums')}>
                        {formatCount(row.month)} / {formatCount(row.caps.monthly)}
                      </td>
                      <td className={TD}>
                        {row.openFindings.pause + row.openFindings.warning === 0
                          ? 'None'
                          : `${formatCount(row.openFindings.pause)} pause, ${formatCount(row.openFindings.warning)} warning`}
                      </td>
                      <td className={cn(TD, 'whitespace-nowrap')}>{formatWhen(row.createdAt)}</td>
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

export default function AccountsPage({ searchParams }: { searchParams: Params }) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Accounts searchParams={searchParams} />
    </Suspense>
  )
}
