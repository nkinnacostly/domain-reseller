import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { StatusPill } from '@/components/common/status-pill'
import { AccountActions } from '@/features/admin/components/account-actions'
import { AccountFindings } from '@/features/admin/components/account-findings'
import {
  AdminPage,
  Card,
  ErrorState,
  Facts,
  PageSkeleton,
  StatTile,
  TableBox,
  TD,
  TH,
} from '@/features/admin/components/parts'
import {
  domainStatusOf,
  formatCount,
  formatPpm,
  formatWhen,
  sesStatusOf,
  stateOf,
  stateReasonOf,
  TENANT_ACTION,
  TENANT_ACTION_STATE,
} from '@/features/admin/lib/format'
import { getAccount } from '@/features/admin/queries/mail'
import { requireAdmin } from '@/features/admin/queries/session'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Account' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Params = Promise<{ id: string }>

/**
 * One account (MAIL-SPEC §10): its usage against the caps that apply, its
 * 7- and 30-day rates against our levels (§7.4), the findings a resume must
 * name (MR5), SES's side of our pauses, and its domains.
 */
async function Account({ params }: { params: Params }) {
  const admin = await requireAdmin()
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const read = await getAccount(id)
  if (!read.ok) {
    return (
      <AdminPage title="Account">
        <ErrorState code={read.code} retryHref={`/admin/accounts/${id}`} />
      </AdminPage>
    )
  }
  const a = read.data
  if (!a) notFound()

  const st = stateOf(a.state)
  const ses = sesStatusOf(a.sesStatus)
  const openPause = a.findings.find((f) => f.severity === 'pause' && f.resolvedAt === null) ?? null
  const reason = stateReasonOf(a.stateReason)

  return (
    <AdminPage
      title={a.name}
      intro={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{a.tenant}</span>
          <StatusPill tone={st.tone}>{st.label}</StatusPill>
          <StatusPill tone={ses.tone}>{ses.label}</StatusPill>
          {reason ? <span>{reason}</span> : null}
          {a.isE2e ? <StatusPill tone="warning">Test account</StatusPill> : null}
        </span>
      }
      actions={
        <AccountActions
          account={{
            id: a.id,
            name: a.name,
            tenant: a.tenant,
            state: a.state,
            sesStatus: a.sesStatus,
            dailyOverride: a.caps.dailyOverride,
            monthlyOverride: a.caps.monthlyOverride,
          }}
          admin={admin}
          openPauseFinding={openPause ? { id: openPause.id, kind: openPause.kind } : null}
        />
      }
    >
      <section aria-labelledby="usage-heading">
        <h2 id="usage-heading" className="sr-only">
          Usage and rates
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile
            label="Today"
            value={`${formatCount(a.usage.today.queued)} / ${formatCount(a.caps.daily)}`}
            hint="Recipients reserved against today’s cap"
          />
          <StatTile
            label="This month"
            value={`${formatCount(a.usage.month.queued)} / ${formatCount(a.caps.monthly)}`}
            hint="Recipients reserved against the month’s cap"
          />
          <StatTile
            label={`Bounces, ${a.window.days} days`}
            value={formatPpm(a.window.bouncePpm)}
            hint={`${formatCount(a.window.bounced)} of ${formatCount(a.window.sent)} sent; warn ${formatPpm(a.thresholds.bounceWarnPpm)}, pause ${formatPpm(a.thresholds.bouncePausePpm)}`}
          />
          <StatTile
            label={`Complaints, ${a.window.days} days`}
            value={formatPpm(a.window.complaintPpm)}
            hint={`${formatCount(a.window.complained)} of ${formatCount(a.window.sent)} sent; warn ${formatPpm(a.thresholds.complaintWarnPpm)}, pause ${formatPpm(a.thresholds.complaintPausePpm)}`}
          />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Our levels are judged on at least {formatCount(a.thresholds.minSends)} sends over{' '}
          {a.thresholds.windowDays} days. Over 30 days: bounces {formatPpm(a.window30.bouncePpm)},
          complaints {formatPpm(a.window30.complaintPpm)} of {formatCount(a.window30.sent)} sent.
        </p>
      </section>

      <AccountFindings findings={a.findings} sesFindings={a.sesFindings} />

      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Profile and plan" id="profile-heading">
          <Facts
            rows={[
              { label: 'Website', value: a.website ?? '—' },
              {
                label: 'Expected a month',
                value:
                  a.expectedMonthlyVolume === null
                    ? '—'
                    : `${formatCount(a.expectedMonthlyVolume)} emails`,
              },
              {
                label: 'What it sends',
                value: <span className="whitespace-pre-line">{a.useCase ?? '—'}</span>,
              },
              { label: 'Profile complete', value: a.profileComplete ? 'Yes' : 'No' },
              { label: 'Owner', value: a.ownerEmail ?? '—' },
              { label: 'Members', value: formatCount(a.members) },
              { label: 'Plan', value: a.planName ?? a.planCode },
              { label: 'Created', value: formatWhen(a.createdAt) },
              {
                label: 'Reviewed',
                value: a.reviewedAt
                  ? `${formatWhen(a.reviewedAt)} by ${a.reviewedBy ?? '—'}`
                  : 'Not yet',
              },
              {
                label: 'Tenant ready',
                value: a.tenantReadyAt ? formatWhen(a.tenantReadyAt) : 'Not yet',
              },
            ]}
          />
        </Card>
        <Card title="Caps" id="caps-heading">
          <Facts
            rows={[
              { label: 'Daily cap that applies', value: formatCount(a.caps.daily) },
              { label: 'Monthly cap that applies', value: formatCount(a.caps.monthly) },
              {
                label: 'Plan’s caps',
                value: `${formatCount(a.caps.planDaily)} a day, ${formatCount(a.caps.planMonthly)} a month`,
              },
              {
                label: 'Override',
                value:
                  a.caps.dailyOverride === null && a.caps.monthlyOverride === null
                    ? 'None'
                    : `${formatCount(a.caps.dailyOverride)} a day, ${formatCount(a.caps.monthlyOverride)} a month`,
              },
              {
                label: 'Warm-up',
                value:
                  a.caps.warmupDay === null
                    ? 'Not warming up'
                    : `Day ${a.caps.warmupDay}: up to ${formatCount(a.caps.warmupCap)} a day`,
              },
              {
                label: 'Sandbox cap',
                value: `${formatCount(a.caps.sandboxDaily)} a day, members only`,
              },
            ]}
          />
          {a.capNotices.length > 0 ? (
            <ul className="mt-4 space-y-1 text-sm">
              {a.capNotices.map((n) => (
                <li key={`${n.scope}-${n.periodStart}-${n.level}`}>
                  {n.level}% of the {n.scope === 'day' ? 'daily' : 'monthly'} cap (
                  {formatCount(n.used)} of {formatCount(n.cap)}) on {n.periodStart}
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      </div>

      <Card title="SES’s side of our pauses" id="tenant-actions-heading">
        {a.tenantActions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing has been asked of SES for this account.
          </p>
        ) : (
          <TableBox label="SES status changes">
            <table className="w-full min-w-[40rem] border-collapse">
              <thead className="border-b border-border">
                <tr>
                  <th scope="col" className={TH}>
                    Change
                  </th>
                  <th scope="col" className={TH}>
                    State
                  </th>
                  <th scope="col" className={TH}>
                    Asked
                  </th>
                  <th scope="col" className={TH}>
                    Tries
                  </th>
                  <th scope="col" className={TH}>
                    Last answer
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {a.tenantActions.map((t) => {
                  const s = TENANT_ACTION_STATE[t.state] ?? {
                    label: t.state,
                    tone: 'neutral' as const,
                  }
                  return (
                    <tr key={t.id}>
                      <td className={TD}>{TENANT_ACTION[t.sendingStatus] ?? t.sendingStatus}</td>
                      <td className={TD}>
                        <StatusPill tone={s.tone}>{s.label}</StatusPill>
                      </td>
                      <td className={cn(TD, 'whitespace-nowrap')}>
                        {formatWhen(t.requestedAt)} by {t.requestedBy}
                      </td>
                      <td className={cn(TD, 'tabular-nums')}>{t.attempts}</td>
                      <td className={TD}>
                        {t.appliedAt ? `Applied ${formatWhen(t.appliedAt)}` : (t.lastError ?? '—')}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableBox>
        )}
      </Card>

      <Card title="Domains" id="domains-heading">
        {a.domains.length === 0 ? (
          <p className="text-sm text-muted-foreground">No domain has been added.</p>
        ) : (
          <ul className="divide-y divide-border">
            {a.domains.map((d) => {
              const s = domainStatusOf(d.status)
              return (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <span className="min-w-0 break-all font-mono text-sm">{d.name}</span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <StatusPill tone={s.tone}>{s.label}</StatusPill>
                    {d.verifiedAt ? `since ${formatWhen(d.verifiedAt)}` : null}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </AdminPage>
  )
}

export default function AccountPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Account params={params} />
    </Suspense>
  )
}
