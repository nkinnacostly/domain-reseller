'use client'

import { explainCharge } from '@/features/admin/actions/supplier'
import { ConfirmAction } from '@/features/admin/components/confirm-action'
import { adminOutcome } from '@/features/admin/lib/errors'
import { formatUsd } from '@/features/admin/lib/format'
import { EXPLAIN_CHARGE } from '@/features/admin/lib/supplier-copy'

/**
 * "Explain this charge" (money, owner): on an unexplained debit, the owner
 * says what it was — a domain bought in DomainNameAPI's own panel (migration
 * 69); on a matched one charged unlike its recorded cost, why the price moved
 * (migration 70), its warning shown. A reason and the authenticator code (D6); the alert closes,
 * and the words are kept with the entry.
 */
export function ExplainCharge({
  traceId,
  description,
  deltaCents,
  priceWarning = null,
  returnTo,
}: {
  traceId: string
  description: string
  deltaCents: number
  /** Set for a price difference: its open warning, in the alert's words. */
  priceWarning?: string | null
  returnTo: string
}) {
  const price = priceWarning !== null
  return (
    <ConfirmAction
      trigger={EXPLAIN_CHARGE.trigger}
      triggerClassName="mt-1"
      title={price ? EXPLAIN_CHARGE.price.title : EXPLAIN_CHARGE.title}
      body={price ? EXPLAIN_CHARGE.price.body : EXPLAIN_CHARGE.body}
      rows={[
        { label: EXPLAIN_CHARGE.rows.entry, value: description || traceId },
        { label: EXPLAIN_CHARGE.rows.charged, value: formatUsd(-deltaCents) },
        ...(price ? [{ label: EXPLAIN_CHARGE.price.rows.warning, value: priceWarning }] : []),
      ]}
      confirmLabel={EXPLAIN_CHARGE.confirm}
      cancelLabel={EXPLAIN_CHARGE.cancel}
      reason="required"
      reasonLabel={price ? EXPLAIN_CHARGE.price.reasonLabel : EXPLAIN_CHARGE.reasonLabel}
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
