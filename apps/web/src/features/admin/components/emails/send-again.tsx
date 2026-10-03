'use client'

import { requeueEmail } from '@/features/admin/actions/emails'
import { ConfirmAction, type ConfirmRow } from '@/features/admin/components/confirm-action'
import { SEND_AGAIN, tries } from '@/features/admin/lib/emails-copy'
import { adminOutcome } from '@/features/admin/lib/errors'

/**
 * "Send again" for one failed email (docs/ADMIN-SPEC.md §5.2, B11): an
 * operator's standard action, so the dialog asks for an optional reason and
 * no code. Offered only where the server decided it may be (failed, not
 * bounced, not reported as spam, a role that may); SQL decides again and
 * answers in words. The recipient is shown masked, the error with its
 * addresses replaced.
 */
export function SendAgain({
  emailId,
  kind,
  reference,
  maskedTo,
  attempts,
  lastErrorSafe,
  returnTo,
}: {
  emailId: string
  /** The kind in words, "Order receipt". */
  kind: string
  /** A short reference that tells this email from the others in the list. */
  reference: string
  maskedTo: string | null
  attempts: number
  lastErrorSafe: string | null
  returnTo: string
}) {
  const rows: ConfirmRow[] = [
    { label: 'Email', value: kind },
    { label: 'To', value: <span className="font-mono text-xs">{maskedTo ?? '—'}</span> },
    { label: 'Failed after', value: tries(attempts) },
    ...(lastErrorSafe
      ? [{ label: 'Last error', value: <span className="text-xs">{lastErrorSafe}</span> }]
      : []),
  ]
  return (
    <ConfirmAction
      trigger={
        <>
          {SEND_AGAIN.trigger}{' '}
          <span className="sr-only">
            the {kind} email {reference}
          </span>
        </>
      }
      title={SEND_AGAIN.title}
      rows={rows}
      body={SEND_AGAIN.body}
      confirmLabel={SEND_AGAIN.confirmLabel}
      cancelLabel={SEND_AGAIN.cancelLabel}
      reason="optional"
      returnTo={returnTo}
      successMessage={SEND_AGAIN.done}
      run={async ({ reason, requestKey }) =>
        adminOutcome(await requeueEmail({ emailId, reason, requestKey }))
      }
    />
  )
}
