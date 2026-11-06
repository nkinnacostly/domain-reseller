'use client'

import { explainCharge } from '@/features/admin/actions/supplier'
import { ConfirmAction } from '@/features/admin/components/confirm-action'
import { adminOutcome } from '@/features/admin/lib/errors'
import { formatUsd } from '@/features/admin/lib/format'
import { EXPLAIN_CHARGE } from '@/features/admin/lib/supplier-copy'

/**
 * "Explain this charge" on an unexplained debit (migration 69; money, owner):
 * the owner says what it was — a domain bought in DomainNameAPI's own panel —
 * with a reason and the authenticator code (D6). The entry becomes explained,
 * its alert closes, and the words are kept with it.
 */
export function ExplainCharge({
  traceId,
  description,
  deltaCents,
  returnTo,
}: {
  traceId: string
  description: string
  deltaCents: number
  returnTo: string
}) {
  return (
    <ConfirmAction
      trigger={EXPLAIN_CHARGE.trigger}
      triggerClassName="mt-1"
      title={EXPLAIN_CHARGE.title}
      body={EXPLAIN_CHARGE.body}
      rows={[
        { label: EXPLAIN_CHARGE.rows.entry, value: description || traceId },
        { label: EXPLAIN_CHARGE.rows.charged, value: formatUsd(-deltaCents) },
      ]}
      confirmLabel={EXPLAIN_CHARGE.confirm}
      cancelLabel={EXPLAIN_CHARGE.cancel}
      reason="required"
      reasonLabel={EXPLAIN_CHARGE.reasonLabel}
      needsCode
      returnTo={returnTo}
      successMessage={EXPLAIN_CHARGE.done}
      run={async ({ reason, requestKey, code }) =>
        adminOutcome(
          await explainCharge({ traceId, reason: reason ?? '', requestKey, code: code ?? '' }),
        )
      }
    />
  )
}
