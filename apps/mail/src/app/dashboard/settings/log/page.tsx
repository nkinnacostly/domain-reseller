import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PageSkeleton } from '@/features/accounts/components/dashboard-skeleton'
import { PartError } from '@/features/accounts/components/overview-parts'
import { describeAction, describeActor } from '@/features/accounts/lib/audit'
import { memberName } from '@/features/accounts/lib/people'
import { canManageMembers } from '@/features/accounts/lib/roles'
import { getCurrentAccount } from '@/features/accounts/queries/accounts'
import { AUDIT_PAGE_SIZE, getAuditLog } from '@/features/accounts/queries/audit'
import { getMembers } from '@/features/accounts/queries/members'

export const metadata: Metadata = { title: 'Account log' }

const when = new Intl.DateTimeFormat('en-NG', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Africa/Lagos',
})

/**
 * The account's security log (MAIL-SPEC §9, §10): keys made and revoked,
 * members added and removed, settings changed — for owners and admins.
 */
async function AccountLog() {
  const data = await getCurrentAccount()
  if (!data) return null
  const { account, role } = data.current
  if (!canManageMembers(role)) {
    return (
      <p className="max-w-xl text-pretty text-sm text-muted-foreground">
        The account log is for the account’s owner and admins. Ask one of them if you need to know
        who changed something.
      </p>
    )
  }
  const [rows, members] = await Promise.all([getAuditLog(account.id), getMembers(account.id)])
  if (!rows) return <PartError what="the account log" retryHref="/dashboard/settings/log" />
  const names = new Map((members ?? []).map((m) => [m.userId, memberName(m)]))

  return (
    <section aria-labelledby="log-heading" className="space-y-4">
      <div>
        <h2 id="log-heading" className="text-lg font-semibold">
          Account log
        </h2>
        <p className="mt-1 text-pretty text-sm text-muted-foreground">
          Security changes to this account, newest first, in Lagos time
          {rows.length === AUDIT_PAGE_SIZE ? ` (the latest ${AUDIT_PAGE_SIZE})` : ''}.
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing has been logged yet.</p>
      ) : (
        <div className="relative overflow-x-auto rounded-3xl border border-border bg-card">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">The account log</caption>
            <thead className="border-b border-border text-muted-foreground">
              <tr>
                <th scope="col" className="px-5 py-3 font-medium">
                  When
                </th>
                <th scope="col" className="px-5 py-3 font-medium">
                  Who
                </th>
                <th scope="col" className="px-5 py-3 font-medium">
                  What
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="whitespace-nowrap px-5 py-3 tabular-nums text-muted-foreground">
                    {when.format(new Date(row.at))}
                  </td>
                  <td className="px-5 py-3">{describeActor(row, names)}</td>
                  <td className="px-5 py-3">{describeAction(row, names)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export default function AccountLogPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <AccountLog />
    </Suspense>
  )
}
