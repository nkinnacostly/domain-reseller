'use client'

import { activateFxRate, rejectFxRate } from '@/features/admin/actions/pricing'
import { ConfirmAction } from '@/features/admin/components/confirm-action'
import { adminOutcome } from '@/features/admin/lib/errors'
import type { activateCopy, rejectCopy } from '@/features/admin/lib/pricing-copy'

type Copy = ReturnType<typeof activateCopy> | ReturnType<typeof rejectCopy>

/**
 * Activate and Reject for one held rate (docs/ADMIN-SPEC.md §5.2 B12), each
 * a money action: the dialog asks for a reason and a fresh code, the server
 * verifies the code against this session's factor, and one audited wrapper
 * decides. Whether Activate is offered was decided on the server (a rate
 * quoted 48 hours ago or more, or before the active one, offers Reject
 * only); the words were written there too, prices included, by the shared
 * pricing functions. SQL decides again, and refuses anyone but the owner.
 */
export function RateActions({
  rateId,
  rateLabel,
  activate,
  reject,
}: {
  rateId: string
  /** "₦1,700.00": in each button's words, so one held rate's buttons differ from another's. */
  rateLabel: string
  /** Null when only Reject is offered. */
  activate: Copy | null
  reject: Copy
}) {
  const returnTo = '/admin/pricing/fx'
  return (
    <div className="flex flex-wrap gap-3">
      {activate ? (
        <ConfirmAction
          trigger={`Activate ${rateLabel}`}
          title={activate.title}
          rows={activate.rows}
          body={activate.body}
          confirmLabel={activate.confirmLabel}
          cancelLabel={activate.cancelLabel}
          reason="required"
          needsCode
          returnTo={returnTo}
          successMessage={activate.success}
          run={async ({ reason, requestKey, code }) =>
            adminOutcome(
              await activateFxRate({ rateId, reason: reason ?? '', requestKey, code: code ?? '' }),
            )
          }
        />
      ) : null}
      <ConfirmAction
        trigger={`Reject ${rateLabel}`}
        title={reject.title}
        rows={reject.rows}
        body={reject.body}
        confirmLabel={reject.confirmLabel}
        cancelLabel={reject.cancelLabel}
        reason="required"
        destructive
        needsCode
        returnTo={returnTo}
        successMessage={reject.success}
        run={async ({ reason, requestKey, code }) =>
          adminOutcome(
            await rejectFxRate({ rateId, reason: reason ?? '', requestKey, code: code ?? '' }),
          )
        }
      />
    </div>
  )
}
