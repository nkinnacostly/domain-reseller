'use client'

import { approveRefund, cancelRefund, retryRefund } from '@/features/admin/actions/refunds'
import { ConfirmAction, type ConfirmRow } from '@/features/admin/components/confirm-action'
import { adminOutcome } from '@/features/admin/lib/errors'
import {
  approveCopy,
  CANCEL_COPY,
  CANCEL_NOTE_MAX,
  heldBecause,
  NO_MONEY_CHECK,
  naira,
  PROVIDER_CHECK,
  type RefundLimits,
  retryCopy,
} from '@/features/admin/lib/refunds-copy'
import type { RefundOffers } from '@/features/admin/lib/refunds-rules'

/**
 * Approve, Retry and Cancel for one refund (ADMIN-SPEC §5.2 B3), each a
 * money action: the dialog asks for a reason and a fresh code, the server
 * verifies the code against this session's factor, and one audited wrapper
 * decides. Which of them appear was decided on the server, by status,
 * playbook and role; SQL decides again.
 */

export type ActionRefund = {
  id: string
  amountKobo: number
  status: string
  lastErrorCode: string | null
  orderNumber: string | null
  forWhat: string
  providerCalled: boolean
}

export function RefundActions({
  refund,
  offers,
  limits,
  sent24hKobo,
}: {
  refund: ActionRefund
  offers: Pick<RefundOffers, 'approve' | 'retry' | 'cancel'>
  limits: RefundLimits
  sent24hKobo: number
}) {
  const returnTo = `/admin/refunds/${refund.id}`
  const order = refund.orderNumber ?? 'Unknown order'
  const amount = naira(refund.amountKobo)
  const providerChecks = refund.providerCalled ? [PROVIDER_CHECK] : []
  const baseRows: ConfirmRow[] = [
    { label: 'Order', value: order },
    { label: 'For', value: refund.forWhat },
    { label: 'Amount', value: amount },
  ]

  const approve = approveCopy(refund.amountKobo)
  const retry = retryCopy(refund.amountKobo, limits)
  const held = heldBecause(refund.lastErrorCode, limits, sent24hKobo)

  return (
    <div className="flex flex-wrap gap-3">
      {offers.approve ? (
        <ConfirmAction
          trigger="Approve refund"
          title={approve.title}
          rows={[...baseRows, { label: 'Held because', value: held ?? '—' }]}
          body={approve.body}
          confirmLabel={approve.confirmLabel}
          cancelLabel={approve.cancelLabel}
          reason="required"
          needsCode
          returnTo={returnTo}
          successMessage={approve.success}
          run={async ({ reason, requestKey, code }) =>
            adminOutcome(
              await approveRefund({
                refundId: refund.id,
                reason: reason ?? '',
                requestKey,
                code: code ?? '',
              }),
            )
          }
        />
      ) : null}

      {offers.retry ? (
        <ConfirmAction
          trigger="Retry refund"
          title={retry.title}
          rows={[...baseRows, { label: 'Last code', value: refund.lastErrorCode ?? '—' }]}
          body={
            <>
              <p>{retry.body}</p>
              <p className="mt-2 font-medium text-foreground">{retry.warning}</p>
            </>
          }
          checks={providerChecks}
          confirmLabel={retry.confirmLabel}
          cancelLabel={retry.cancelLabel}
          reason="required"
          needsCode
          returnTo={returnTo}
          successMessage={retry.success}
          run={async ({ reason, requestKey, code, checks }) =>
            adminOutcome(
              await retryRefund({
                refundId: refund.id,
                checkedProvider: Boolean(checks[PROVIDER_CHECK.id]),
                reason: reason ?? '',
                requestKey,
                code: code ?? '',
              }),
            )
          }
        />
      ) : null}

      {offers.cancel ? (
        <ConfirmAction
          trigger="Cancel refund"
          title={CANCEL_COPY.title}
          rows={baseRows}
          body={CANCEL_COPY.body}
          checks={[NO_MONEY_CHECK, ...providerChecks]}
          reason="required"
          reasonLabel={CANCEL_COPY.noteLabel}
          reasonMax={CANCEL_NOTE_MAX}
          typeToConfirm={refund.orderNumber ?? refund.id}
          confirmLabel={CANCEL_COPY.confirmLabel}
          cancelLabel={CANCEL_COPY.cancelLabel}
          destructive
          needsCode
          returnTo={returnTo}
          successMessage={CANCEL_COPY.success}
          run={async ({ reason, requestKey, code, checks }) =>
            adminOutcome(
              await cancelRefund({
                refundId: refund.id,
                note: reason ?? '',
                noMoneyMoved: Boolean(checks[NO_MONEY_CHECK.id]),
                checkedProvider: Boolean(checks[PROVIDER_CHECK.id]),
                requestKey,
                code: code ?? '',
              }),
            )
          }
        />
      ) : null}
    </div>
  )
}
