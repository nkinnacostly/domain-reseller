import type { Metadata } from 'next'
import { Suspense } from 'react'
import { StatusPill } from '@/components/common/status-pill'
import {
  AdminPage,
  Card,
  ErrorState,
  PageSkeleton,
  StatTile,
} from '@/features/admin/components/parts'
import { formatCount, formatPpm, formatWhen, heartbeatLabel } from '@/features/admin/lib/format'
import { getSesHealth } from '@/features/admin/queries/mail'
import { requireAdmin } from '@/features/admin/queries/session'

export const metadata: Metadata = { title: 'SES health' }

/** A share of the quota as a whole percentage, or a dash. */
const share = (value: number | null) => (value === null ? '—' : `${Math.floor(value * 100)}%`)

/**
 * The whole SES account (MAIL-SPEC §4.4, §7.8, §11): the 24-hour quota and
 * send rate, Mail's own budget, CloudWatch's reputation against our alert
 * levels and AWS's, the worker's heartbeats and the event stream — as the
 * worker last read them. Nothing here calls AWS (no SES call on render).
 */
async function Health() {
  await requireAdmin()
  const read = await getSesHealth()
  if (!read.ok) {
    return (
      <AdminPage title="SES health">
        <ErrorState code={read.code} retryHref="/admin/health" />
      </AdminPage>
    )
  }
  const h = read.data
  const rep = h.reputation
  return (
    <AdminPage
      title="SES health"
      intro="The SES account Mail shares with the shop’s own email, as the worker last read it."
    >
      <section aria-labelledby="quota-heading">
        <h2 id="quota-heading" className="mb-3 font-semibold">
          Quota and rate
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile
            label="24-hour quota used"
            value={share(h.quota?.share ?? null)}
            hint={
              h.quota
                ? `${formatCount(h.quota.sentLast24Hours)} of ${formatCount(h.quota.max24HourSend)}; alert at ${h.quotaAlertPct}%`
                : 'Not read yet'
            }
          />
          <StatTile
            label="Send rate"
            value={
              h.quota?.maxSendRate === null || !h.quota
                ? '—'
                : `${formatCount(h.quota.maxSendRate)} a second`
            }
            hint="The account’s limit, shared with the shop"
          />
          <StatTile
            label="Mail’s 24 hours"
            value={formatCount(h.budget.reserved24h)}
            hint={`of Mail’s budget of ${formatCount(h.budget.dailyBudget)}`}
          />
          <StatTile
            label="Free and sandbox accounts"
            value={h.quota?.holdFree ? 'Waiting' : 'Sending'}
            hint="They wait while the day is nearly spent"
          />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {h.quota
            ? `Read ${formatWhen(h.quota.readAt)}.`
            : 'The worker has not read the quota yet.'}
        </p>
      </section>

      <Card title="Reputation (CloudWatch)" id="reputation-heading">
        <div className="grid gap-4 sm:grid-cols-2">
          <StatTile
            label="Bounce rate"
            value={formatPpm(rep.latest?.bouncePpm)}
            hint={`Alert at ${formatPpm(rep.bounceWarnPpm)}, urgent at ${formatPpm(rep.bouncePausePpm)}; AWS reviews at 5%`}
          />
          <StatTile
            label="Complaint rate"
            value={formatPpm(rep.latest?.complaintPpm)}
            hint={`Alert at ${formatPpm(rep.complaintWarnPpm)}, urgent at ${formatPpm(rep.complaintPausePpm)}; AWS reviews at 0.1%`}
          />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {rep.latest ? `Last reading ${formatWhen(rep.latest.readAt)}.` : 'No reading yet.'}{' '}
          {rep.lastReadAt
            ? `The worker last asked ${formatWhen(rep.lastReadAt)} (${rep.lastOutcome === 'ok' ? 'answered' : rep.lastOutcome === 'no_data' ? 'no data' : 'failed'}).`
            : ''}
        </p>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Worker" id="worker-heading">
          {h.heartbeats.length === 0 ? (
            <p className="text-sm text-muted-foreground">The worker has not reported yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {h.heartbeats.map((beat) => (
                <li
                  key={beat.name}
                  className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm"
                >
                  <span className="font-medium">{heartbeatLabel(beat.name)}</span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {formatWhen(beat.beatAt)}
                    <StatusPill tone={beat.silent ? 'danger' : 'success'}>
                      {beat.silent ? 'Silent' : 'Reporting'}
                    </StatusPill>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Events and SES changes" id="events-heading">
          <ul className="space-y-2 text-sm">
            <li>Sent in the last hour: {formatCount(h.events.sentLastHour)}</li>
            <li>Last SES event received: {formatWhen(h.events.lastReceivedAt)}</li>
            <li>Pauses and resumes waiting for SES: {formatCount(h.pendingTenantActions)}</li>
          </ul>
        </Card>
      </div>
    </AdminPage>
  )
}

export default function HealthPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Health />
    </Suspense>
  )
}
