'use client'

import type { AdminFlwRefundCheck } from '@dr/shared/admin'
import { useState } from 'react'
import { recordManualRefund } from '@/features/admin/actions/refunds'
import { ConfirmAction } from '@/features/admin/components/confirm-action'
import { adminOutcome } from '@/features/admin/lib/errors'
import { CHECK_STEP, naira, PROVIDER_CHECK, recordCopy } from '@/features/admin/lib/refunds-copy'
import { checkProblems } from '@/features/admin/lib/refunds-rules'
import { FlwCheck, useNow } from './flw-check'

/**
 * Recording a refund sent from the Flutterwave dashboard (ADMIN-SPEC §5.2
 * B3, D23), in one dialog with two steps: check it with Flutterwave from
 * there, then record it. The record button is enabled only while a
 * completed check for this amount, on this order's charge, is under 15
 * minutes old; the wrapper checks all of it again before the customer's
 * order page shows the money as refunded.
 */
export function RecordRefund({
  refund,
}: {
  refund: {
    id: string
    amountKobo: number
    orderNumber: string | null
    forWhat: string
    providerCalled: boolean
    /** The charge Flutterwave knows this order's payment by (`admin_payments_v`). */
    providerReference: string | null
  }
}) {
  const [check, setCheck] = useState<AdminFlwRefundCheck | null>(null)
  const now = useNow(check !== null)
  const problems = check
    ? checkProblems(
        check,
        {
          amountKobo: refund.amountKobo,
          ...(refund.providerReference ? { transactionId: refund.providerReference } : {}),
        },
        now,
      )
    : []
  const ready = check !== null && problems.length === 0
  const copy = recordCopy(refund.amountKobo)
  const returnTo = `/admin/refunds/${refund.id}`

  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-muted-foreground">{CHECK_STEP.intro}</p>
      <ConfirmAction
        trigger={CHECK_STEP.trigger}
        title={copy.title}
        rows={[
          { label: 'Order', value: refund.orderNumber ?? 'Unknown order' },
          { label: 'For', value: refund.forWhat },
          { label: 'Amount', value: naira(refund.amountKobo) },
          { label: 'Charge', value: refund.providerReference ?? 'Not recorded' },
        ]}
        body={copy.body}
        checks={refund.providerCalled ? [PROVIDER_CHECK] : []}
        confirmLabel={copy.confirmLabel}
        cancelLabel={copy.cancelLabel}
        reason="required"
        needsCode
        canConfirm={ready}
        notReadyHint={CHECK_STEP.needsCheck}
        returnTo={returnTo}
        successMessage={copy.success}
        run={async ({ reason, requestKey, code, checks }) => {
          if (!check) return { ok: false, code: 'FLW_NOT_VERIFIED', message: CHECK_STEP.needsCheck }
          return adminOutcome(
            await recordManualRefund({
              refundId: refund.id,
              checkId: check.checkId,
              flwRefundId: check.flwRefundId,
              checkedProvider: Boolean(checks[PROVIDER_CHECK.id]),
              reason: reason ?? '',
              requestKey,
              code: code ?? '',
            }),
          )
        }}
      >
        <FlwCheck
          target={{ refundId: refund.id }}
          targetWord="refund"
          check={check}
          problems={problems}
          onCheck={setCheck}
          returnTo={returnTo}
        />
      </ConfirmAction>
    </div>
  )
}
