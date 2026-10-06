import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import {
  AdminPage,
  Card,
  ErrorState,
  LINK,
  PageSkeleton,
  StatTile,
} from '@/features/admin/components/parts'
import { formatCount } from '@/features/admin/lib/format'
import { getOverview } from '@/features/admin/queries/mail'
import { requireAdmin } from '@/features/admin/queries/session'

export const metadata: Metadata = { title: 'Overview' }

/** Where Mail's accounts stand, and what needs a person (MAIL-SPEC §10). */
async function Overview() {
  await requireAdmin()
  const read = await getOverview()
  if (!read.ok) {
    return (
      <AdminPage title="Mail admin">
        <ErrorState code={read.code} retryHref="/admin" />
      </AdminPage>
    )
  }
  const o = read.data
  return (
    <AdminPage
      title="Mail admin"
      intro="Accounts waiting for review, paused, or over our warning level, and SES’s side of our pauses."
    >
      <section aria-labelledby="attention-heading">
        <h2 id="attention-heading" className="sr-only">
          Needs a person
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile
            label="Ready for review"
            value={formatCount(o.reviewReady)}
            hint={`${formatCount(o.accounts.sandbox)} in the sandbox in all`}
            href="/admin/review"
          />
          <StatTile
            label="Paused"
            value={formatCount(o.accounts.paused)}
            hint={`${formatCount(o.findings.pause)} open pause findings`}
            href="/admin/accounts?state=paused"
          />
          <StatTile
            label="Over our warning level"
            value={formatCount(o.findings.warning)}
            hint="Open warning findings, on the accounts list"
            href="/admin/accounts"
          />
          <StatTile
            label="SES changes waiting"
            value={formatCount(o.pendingTenantActions)}
            hint="Pauses and resumes not yet applied at SES"
            href="/admin/health"
          />
        </div>
      </section>
      <Card title="Accounts" id="accounts-heading">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          {(
            [
              ['Sandbox', o.accounts.sandbox, '/admin/accounts?state=sandbox'],
              ['Active', o.accounts.active, '/admin/accounts?state=active'],
              ['Paused', o.accounts.paused, '/admin/accounts?state=paused'],
              ['Closed', o.accounts.closed, '/admin/accounts?state=closed'],
              ['Paused at SES', o.accounts.sesPaused, '/admin/accounts'],
            ] as const
          ).map(([label, value, href]) => (
            <div key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="mt-0.5 text-lg font-semibold tabular-nums">
                <Link href={href} className={LINK}>
                  {formatCount(value)}
                  <span className="sr-only"> {label.toLowerCase()} accounts</span>
                </Link>
              </dd>
            </div>
          ))}
        </dl>
      </Card>
      {o.testOnly ? null : (
        <p className="text-sm text-muted-foreground">
          The SES account’s quota, send rate and reputation are on{' '}
          <Link href="/admin/health" className={LINK}>
            SES health
          </Link>
          .
        </p>
      )}
    </AdminPage>
  )
}

export default function AdminOverviewPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Overview />
    </Suspense>
  )
}
