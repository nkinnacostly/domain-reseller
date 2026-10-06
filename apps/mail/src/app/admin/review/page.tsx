import { CircleCheck, CircleDashed } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import { StatusPill } from '@/components/common/status-pill'
import { AccountActions } from '@/features/admin/components/account-actions'
import {
  AdminPage,
  EmptyState,
  ErrorState,
  LINK,
  PageSkeleton,
} from '@/features/admin/components/parts'
import { formatCount, formatWhen, sesStatusOf } from '@/features/admin/lib/format'
import { getReviewQueue, type ReviewRow } from '@/features/admin/queries/mail'
import { requireAdmin } from '@/features/admin/queries/session'

export const metadata: Metadata = { title: 'Review queue' }

function Check({ done, children }: { done: boolean; children: React.ReactNode }) {
  const Icon = done ? CircleCheck : CircleDashed
  return (
    <li className="flex items-start gap-2 text-sm">
      <Icon
        className={
          done
            ? 'mt-0.5 size-4 shrink-0 text-tone-success-foreground'
            : 'mt-0.5 size-4 shrink-0 text-muted-foreground'
        }
        aria-hidden="true"
      />
      <span>
        {children}
        <span className="sr-only">{done ? ' (done)' : ' (not yet)'}</span>
      </span>
    </li>
  )
}

function ReviewCard({
  row,
  admin,
}: {
  row: ReviewRow
  admin: Awaited<ReturnType<typeof requireAdmin>>
}) {
  const ses = sesStatusOf(row.sesStatus)
  return (
    <li className="rounded-3xl border border-border bg-card p-5 sm:p-6" data-account={row.id}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold break-words">
            <Link href={`/admin/accounts/${row.id}`} className={LINK}>
              {row.name}
            </Link>
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            <span className="font-mono">{row.tenant}</span> · {row.planCode} plan · since{' '}
            {formatWhen(row.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusPill tone={row.ready ? 'success' : 'neutral'}>
            {row.ready ? 'Ready for review' : 'Not ready'}
          </StatusPill>
          <StatusPill tone={ses.tone}>{ses.label}</StatusPill>
        </div>
      </div>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">Website</dt>
          <dd className="break-words">{row.website ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Expected a month</dt>
          <dd>
            {row.expectedMonthlyVolume === null
              ? '—'
              : `${formatCount(row.expectedMonthlyVolume)} emails`}
          </dd>
        </div>
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-xs text-muted-foreground">What it will send</dt>
          <dd className="break-words whitespace-pre-line">{row.useCase ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Owner</dt>
          <dd>{row.ownerEmail ?? '—'}</dd>
        </div>
      </dl>
      <ul className="mt-4 space-y-1.5" aria-label="Before it can leave the sandbox">
        <Check done={row.verifiedDomains > 0}>
          A verified domain ({formatCount(row.verifiedDomains)} verified,{' '}
          {formatCount(row.pendingDomains)} pending)
        </Check>
        <Check done={row.profileComplete}>
          A complete profile: website, what it sends, its volume
        </Check>
      </ul>
      <div className="mt-5">
        <AccountActions
          account={{
            id: row.id,
            name: row.name,
            tenant: row.tenant,
            state: 'sandbox',
            sesStatus: row.sesStatus,
            dailyOverride: null,
            monthlyOverride: null,
          }}
          admin={admin}
          openPauseFinding={null}
        />
      </div>
    </li>
  )
}

/** §7.2: every sandbox account, the ready ones first — approve, or reject and close. */
async function ReviewQueue() {
  const admin = await requireAdmin()
  const read = await getReviewQueue()
  return (
    <AdminPage
      title="Review queue"
      intro="An account leaves the sandbox once it has a verified domain, a complete profile, and an admin’s approval (§7.2). Approval starts its warm-up; rejection closes it."
    >
      {!read.ok ? (
        <ErrorState code={read.code} retryHref="/admin/review" />
      ) : read.data.length === 0 ? (
        <EmptyState
          title="No account is waiting"
          body="New accounts start in the sandbox and appear here."
        />
      ) : (
        <ul className="space-y-4">
          {read.data.map((row) => (
            <ReviewCard key={row.id} row={row} admin={admin} />
          ))}
        </ul>
      )}
    </AdminPage>
  )
}

export default function ReviewPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ReviewQueue />
    </Suspense>
  )
}
