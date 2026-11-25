'use client'

import { reviewScreening } from '@/features/admin/actions/screening'
import { ConfirmAction } from '@/features/admin/components/confirm-action'
import { adminOutcome } from '@/features/admin/lib/errors'
import { REVIEW } from '@/features/admin/lib/screening-copy'

/**
 * "Looks fine" and "Abuse" on a name waiting for a review (migration 73): a
 * reason each, no code — it records a finding and changes no money or order.
 */
export function ReviewScreening({
  orderItemId,
  domain,
  matched,
  note,
}: {
  orderItemId: string
  domain: string
  matched: string[]
  note: string | null
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {(['fine', 'abuse'] as const).map((decision) => (
        <ConfirmAction
          key={decision}
          trigger={REVIEW[decision].trigger}
          title={REVIEW[decision].title}
          body={REVIEW[decision].body}
          rows={[
            { label: REVIEW.rows.name, value: domain },
            { label: REVIEW.rows.matched, value: matched.join(', ') || '—' },
            ...(note ? [{ label: REVIEW.rows.note, value: note }] : []),
          ]}
          confirmLabel={REVIEW[decision].confirm}
          destructive={decision === 'abuse'}
          reason="required"
          reasonLabel={REVIEW.reasonLabel}
          returnTo={`/admin/screening#line-${orderItemId}`}
          successMessage={REVIEW.done}
          run={async ({ reason, requestKey }) =>
            adminOutcome(
              await reviewScreening({ orderItemId, decision, reason: reason ?? '', requestKey }),
            )
          }
        />
      ))}
    </div>
  )
}
