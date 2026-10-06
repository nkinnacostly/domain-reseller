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
import { ADMIN_ERROR_WORDS } from '@/features/admin/lib/errors'
import { AUDIT_ACTION, AUDIT_OUTCOME, formatCount, formatWhen } from '@/features/admin/lib/format'
import { auditActionOf, listHref, pageOf } from '@/features/admin/lib/params'
import { getAudit, PAGE_SIZE } from '@/features/admin/queries/mail'
import { requireAdmin } from '@/features/admin/queries/session'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Audit log' }

type Params = Promise<Record<string, string | string[] | undefined>>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** §10: every Mail admin action, refusals included, from the shop's append-only log. */
async function Audit({ searchParams }: { searchParams: Params }) {
  const admin = await requireAdmin()
  const params = await searchParams
  const action = auditActionOf(params)
  const page = pageOf(params)
  const read = await getAudit({ action, page })
  const here = (next: Record<string, string | number | null>) =>
    listHref('/admin/audit', { action, page, ...next })

  return (
    <AdminPage
      title="Audit log"
      intro={
        admin.testOnly
          ? 'Mail’s admin actions by test administrators. Live actions are not shown to you.'
          : 'Every Mail admin action — what was asked, by whom, why, and what SQL answered. It is never rewritten.'
      }
    >
      <FilterLinks
        label="Filter by action"
        options={[
          { href: here({ action: null, page: 1 }), label: 'All', current: action === null },
          ...Object.entries(AUDIT_ACTION).map(([value, label]) => ({
            href: here({ action: value, page: 1 }),
            label,
            current: action === value,
          })),
        ]}
      />
      {!read.ok ? (
        <ErrorState code={read.code} retryHref={here({})} />
      ) : read.data.rows.length === 0 ? (
        <EmptyState
          title="Nothing recorded yet"
          body={
            action ? 'Try another action.' : 'Mail admin actions appear here as they are taken.'
          }
        />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {formatCount(read.data.total)} {read.data.total === 1 ? 'entry' : 'entries'}
          </p>
          <TableBox label="Audit log">
            <table className="w-full min-w-[56rem] border-collapse">
              <thead className="border-b border-border">
                <tr>
                  <th scope="col" className={TH}>
                    When
                  </th>
                  <th scope="col" className={TH}>
                    Action
                  </th>
                  <th scope="col" className={TH}>
                    Outcome
                  </th>
                  <th scope="col" className={TH}>
                    Admin
                  </th>
                  <th scope="col" className={TH}>
                    Account
                  </th>
                  <th scope="col" className={TH}>
                    Reason
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {read.data.rows.map((row) => {
                  const outcome = AUDIT_OUTCOME[row.outcome] ?? {
                    label: row.outcome,
                    tone: 'neutral' as const,
                  }
                  return (
                    <tr key={row.id}>
                      <td className={cn(TD, 'whitespace-nowrap')}>{formatWhen(row.createdAt)}</td>
                      <td className={TD}>{AUDIT_ACTION[row.action] ?? row.action}</td>
                      <td className={TD}>
                        <StatusPill tone={outcome.tone}>{outcome.label}</StatusPill>
                        {row.errorCode ? (
                          <span className="mt-1 block max-w-64 text-xs text-muted-foreground">
                            {ADMIN_ERROR_WORDS[row.errorCode] ?? row.errorCode}
                          </span>
                        ) : null}
                      </td>
                      <td className={TD}>
                        {row.adminLabel}
                        <span className="block text-xs text-muted-foreground">
                          {row.adminRole}
                          {row.testActor ? ', test' : ''}
                        </span>
                      </td>
                      <td className={TD}>
                        {row.targetId && UUID.test(row.targetId) ? (
                          <Link
                            href={`/admin/accounts/${row.targetId}`}
                            className={cn(LINK, 'font-mono text-xs')}
                          >
                            {row.targetId.slice(0, 8)}
                            <span className="sr-only">, open the account</span>
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className={cn(TD, 'max-w-80 break-words')}>
                        {row.redacted ? (
                          <span className="text-muted-foreground">Removed</span>
                        ) : (
                          (row.reason ?? '—')
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

export default function AuditPage({ searchParams }: { searchParams: Params }) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Audit searchParams={searchParams} />
    </Suspense>
  )
}
