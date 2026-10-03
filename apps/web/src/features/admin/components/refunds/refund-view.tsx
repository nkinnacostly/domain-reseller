import Link from 'next/link'
import { FOCUS, Panel, PanelHeader, PanelPage } from '@/components/layout/panel'
import { AdminStatusPill, TestBadge } from '@/features/admin/components/admin-status-pill'
import { CopyValue } from '@/features/admin/components/copy-value'
import { DlGrid, type DlItem } from '@/features/admin/components/dl-grid'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { SideSwitch } from '@/features/admin/components/shell/side-switch'
import { Timeline } from '@/features/admin/components/timeline'
import { formatWat } from '@/features/admin/lib/format'
import { adminHref } from '@/features/admin/lib/href'
import {
  LINE_STATUS_LABEL,
  labelFor,
  ORDER_STATUS_LABEL,
  REFUND_REASON_LABEL,
  REFUND_STATUS_LABEL,
} from '@/features/admin/lib/labels'
import { playbookFor } from '@/features/admin/lib/playbook'
import {
  eventDetail,
  eventTitle,
  heldBecause,
  naira,
  refundFor,
} from '@/features/admin/lib/refunds-copy'
import { providerWasCalled, refundOffers } from '@/features/admin/lib/refunds-rules'
import { toneOf } from '@/features/admin/lib/tone'
import { getRefund, getRefundStats, type RefundDetail } from '@/features/admin/queries/refunds'
import { type AdminPrincipal, getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import { cn } from '@/lib/utils'
import { CardHeading, QUIET_LINK } from './parts'
import { RecordRefund } from './record-refund'
import { RefundActions } from './refund-actions'

/**
 * /admin/refunds/[id] (ADMIN-SPEC §5.2 B3): one refund — its summary, the
 * playbook for its code, the automatic limits, its payment and Flutterwave
 * facts, and its timeline — with the buttons its status, playbook and the
 * admin's role allow. After an action the page is read again, so the new
 * status and its event show here.
 */

const CRUMBS = [
  { label: 'Admin', href: '/admin' },
  { label: 'Refunds', href: '/admin/refunds' },
]

const LINK = cn('rounded text-foreground underline underline-offset-4', FOCUS)

function Header({
  admin,
  side,
  title,
  refund,
}: {
  admin: AdminPrincipal
  side: 'live' | 'test'
  title: string
  refund?: RefundDetail
}) {
  return (
    <PanelHeader
      crumbs={[...CRUMBS, { label: title }]}
      title={title}
      titleAside={
        refund ? (
          <span className="inline-flex items-center gap-2">
            <AdminStatusPill value={refund.status} labels={REFUND_STATUS_LABEL} />
            {refund.testMode ? <TestBadge /> : null}
          </span>
        ) : null
      }
      description={
        refund
          ? `${labelFor(REFUND_REASON_LABEL, refund.reason)} · ${naira(refund.amountKobo)}`
          : undefined
      }
      actions={<SideSwitch side={side} testOnly={admin.testOnly} />}
    />
  )
}

export async function RefundView({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin()
  const side = await getAdminSide(admin)
  const { id } = await params
  const [result, stats] = await Promise.all([getRefund(admin, side, id), getRefundStats(side)])

  if (!result.ok) {
    return (
      <PanelPage>
        <Header admin={admin} side={side} title="Refund" />
        <ErrorState title="This refund couldn't be loaded." />
      </PanelPage>
    )
  }
  const refund = result.refund
  if (!refund) {
    return (
      <PanelPage>
        <Header admin={admin} side={side} title="Refund" />
        <EmptyState
          title={`No refund with this id on the ${side === 'test' ? 'Test' : 'Live'} side`}
          body={
            admin.testOnly
              ? 'Test administrators see test-mode refunds only.'
              : 'It may be on the other side: switch sides above, or go back to the list.'
          }
          action={
            <Link href="/admin/refunds" className={QUIET_LINK}>
              Back to refunds
            </Link>
          }
        />
      </PanelPage>
    )
  }

  const forWhat = refundFor(refund.reason, refund.line)
  const facts = {
    status: refund.status,
    lastErrorCode: refund.lastErrorCode,
    providerCalledAt: refund.providerCalledAt,
    providerRefundId: refund.providerRefundId,
  }
  const offers = refundOffers(facts, admin)
  const providerCalled = providerWasCalled(facts)
  const playbook = playbookFor(refund.lastErrorCode)
  const title = `Refund for ${refund.order.orderNumber ?? 'an order'}`
  const actionRefund = {
    id: refund.id,
    amountKobo: refund.amountKobo,
    status: refund.status,
    lastErrorCode: refund.lastErrorCode,
    orderNumber: refund.order.orderNumber,
    forWhat,
    providerCalled,
  }
  const anyAction = offers.approve || offers.retry || offers.cancel

  const summary: DlItem[] = [
    {
      label: 'Order',
      value: (
        <Link href={adminHref.order(refund.order.id)} className={LINK}>
          {refund.order.orderNumber ?? 'Open the order'}
        </Link>
      ),
    },
    { label: 'For', value: forWhat },
    { label: 'Amount', value: naira(refund.amountKobo) },
    { label: 'Reason', value: labelFor(REFUND_REASON_LABEL, refund.reason) },
    {
      label: 'Status',
      value: <AdminStatusPill value={refund.status} labels={REFUND_STATUS_LABEL} />,
    },
    {
      label: 'Code',
      value: refund.lastErrorCode ? (
        <code className="font-mono text-sm">{refund.lastErrorCode}</code>
      ) : (
        '—'
      ),
    },
    { label: 'Created', value: formatWat(refund.createdAt) },
    { label: 'Not sent before', value: formatWat(refund.runAfter) },
    { label: 'Attempts', value: String(refund.attempts) },
    {
      label: 'Approved',
      value: refund.approvedAt
        ? `${formatWat(refund.approvedAt)}${refund.approvedBy ? ` by ${refund.approvedBy}` : ''}`
        : '—',
    },
    { label: 'Refunded', value: formatWat(refund.completedAt) },
  ]
  if (refund.line) {
    summary.push({
      label: 'Line',
      value: (
        <span className="inline-flex flex-wrap items-center gap-2">
          <span className="break-all">{refund.line.domain}</span>
          <AdminStatusPill value={refund.line.status} labels={LINE_STATUS_LABEL} />
          <span className="text-muted-foreground">
            {naira(refund.line.priceKobo)} for {refund.line.periodYears}{' '}
            {refund.line.periodYears === 1 ? 'year' : 'years'}
          </span>
        </span>
      ),
      wide: true,
    })
  }

  const payment: DlItem[] = [
    {
      label: 'Order status',
      value: refund.order.status ? (
        <AdminStatusPill value={refund.order.status} labels={ORDER_STATUS_LABEL} />
      ) : (
        '—'
      ),
    },
    {
      label: 'Order total',
      value: refund.order.totalKobo === null ? '—' : naira(Number(refund.order.totalKobo)),
    },
    { label: 'Paid', value: formatWat(refund.order.paidAt) },
    {
      label: 'Payment reference',
      value: refund.order.txRef ? (
        <CopyValue value={refund.order.txRef} label="payment reference" />
      ) : (
        '—'
      ),
    },
    {
      label: 'Payment record',
      value: <CopyValue value={refund.paymentId} label="payment record id" />,
    },
  ]

  const provider: DlItem[] = [
    { label: 'Flutterwave called', value: formatWat(refund.providerCalledAt) },
    { label: 'Accepted by Flutterwave', value: formatWat(refund.submittedAt) },
    {
      label: 'Flutterwave refund',
      value: refund.providerRefundId ? (
        <CopyValue value={refund.providerRefundId} label="Flutterwave refund id" />
      ) : (
        '—'
      ),
    },
    { label: 'Flutterwave status', value: refund.providerStatus ?? '—' },
    {
      label: 'Bounced references',
      value:
        refund.failedProviderRefundIds.length > 0 ? refund.failedProviderRefundIds.join(', ') : '—',
      wide: true,
    },
  ]

  const held =
    stats && refund.status === 'held'
      ? heldBecause(refund.lastErrorCode, stats.limits, stats.sent24hKobo)
      : null

  return (
    <PanelPage>
      <Header admin={admin} side={side} title={title} refund={refund} />

      <Panel labelledBy="refund-actions-heading" className="space-y-4">
        <CardHeading id="refund-actions-heading">What to do</CardHeading>
        <div className="space-y-1 text-sm">
          <p className="text-foreground">
            {refund.lastErrorCode ? (
              <>
                <code className="font-mono">{refund.lastErrorCode}</code>: {playbook.meaning}
              </>
            ) : (
              'No error recorded for this refund.'
            )}
          </p>
          {refund.lastErrorCode ? <p className="text-muted-foreground">{playbook.next}</p> : null}
          {held ? <p className="text-foreground">Held because: {held}.</p> : null}
        </div>
        {stats ? (
          anyAction ? (
            <RefundActions
              refund={actionRefund}
              offers={offers}
              limits={stats.limits}
              sent24hKobo={stats.sent24hKobo}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {offers.record
                ? 'Check the Flutterwave refund below, then record it.'
                : noActionWords(refund.status, admin)}
            </p>
          )
        ) : (
          <ErrorState
            title="The automatic limits couldn't be read."
            body="No button is offered without them: the dialogs quote them. Nothing was changed. Try again."
          />
        )}
      </Panel>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Panel labelledBy="refund-summary-heading" className="space-y-4 xl:col-span-2">
          <CardHeading id="refund-summary-heading">Summary</CardHeading>
          <DlGrid items={summary} />
        </Panel>

        <Panel labelledBy="refund-limits-heading" className="space-y-4">
          <CardHeading id="refund-limits-heading">Automatic limits</CardHeading>
          {stats ? (
            <DlGrid
              className="sm:grid-cols-2 xl:grid-cols-1"
              items={[
                { label: 'Per refund', value: naira(stats.limits.singleKobo) },
                { label: 'Per day', value: naira(stats.limits.dailyKobo) },
                { label: 'Sent in the last 24 hours', value: naira(stats.sent24hKobo) },
                { label: 'Wait before sending', value: `${stats.limits.delayMinutes} min` },
              ]}
            />
          ) : (
            <p className="text-sm text-muted-foreground">The limits couldn't be read.</p>
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel labelledBy="refund-payment-heading" className="space-y-4">
          <CardHeading id="refund-payment-heading">Payment</CardHeading>
          <DlGrid items={payment} className="xl:grid-cols-2" />
        </Panel>
        <Panel labelledBy="refund-provider-heading" className="space-y-4">
          <CardHeading id="refund-provider-heading">Flutterwave</CardHeading>
          <DlGrid items={provider} className="xl:grid-cols-2" />
        </Panel>
      </div>

      {offers.record ? (
        <Panel labelledBy="refund-record-heading" className="space-y-4">
          <CardHeading id="refund-record-heading">Record a Flutterwave refund</CardHeading>
          <RecordRefund refund={actionRefund} />
        </Panel>
      ) : null}

      <Panel labelledBy="refund-timeline-heading" className="space-y-4">
        <CardHeading id="refund-timeline-heading">Timeline</CardHeading>
        <Timeline
          empty="No events recorded yet."
          events={refund.events.map((event) => {
            const detail = eventDetail(event.detail)
            return {
              id: String(event.id),
              at: event.at,
              title: eventTitle(event.event, event.actor),
              tone: toneOf(event.event),
              ...(detail ? { detail } : {}),
            }
          })}
        />
      </Panel>
    </PanelPage>
  )
}

/** Why no button shows, in words. */
function noActionWords(status: string, admin: { role: string; testOnly: boolean }): string {
  if (admin.role === 'viewer') return 'Your admin role can view refunds only.'
  if (status === 'completed') return 'This refund is done: the money went back.'
  if (status === 'cancelled')
    return 'This refund was cancelled. Only the owner can retry or record it.'
  if (status === 'sending' || status === 'submitted') {
    return 'This refund is with the worker or Flutterwave. Wait for it to finish or stop.'
  }
  if (status === 'queued') {
    return 'This refund is queued: the worker sends it on its next run. Only the owner can cancel it.'
  }
  return 'The playbook offers no button for this code. Read the timeline, then decide; ask before anything that moves money.'
}
