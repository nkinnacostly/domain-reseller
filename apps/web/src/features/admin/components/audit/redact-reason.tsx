'use client'

import { redactAuditReason } from '@/features/admin/actions/audit'
import { ConfirmAction } from '@/features/admin/components/confirm-action'
import { REDACT } from '@/features/admin/lib/audit-copy'
import { adminOutcome } from '@/features/admin/lib/errors'
import { adminHref } from '@/features/admin/lib/href'

/**
 * "Redact reason" on one entry (docs/ADMIN-SPEC.md §2.5, §5.2 B14), shown to
 * the owner only — SQL refuses anyone else and records it. A money action:
 * why, under the usual reason rules, and the code from the authenticator app
 * (D6). Cancel is focused first: the removal cannot be undone.
 */
export function RedactReason({ auditId }: { auditId: number }) {
  return (
    <ConfirmAction
      trigger={
        <>
          {REDACT.trigger}
          <span className="sr-only"> of entry #{auditId}</span>
        </>
      }
      triggerClassName="mt-2"
      title={REDACT.title}
      rows={[{ label: 'Entry', value: `#${auditId}` }]}
      body={REDACT.body}
      confirmLabel={REDACT.confirm}
      cancelLabel={REDACT.cancel}
      reason="required"
      reasonLabel={REDACT.reasonLabel}
      needsCode
      destructive
      returnTo={adminHref.audit(auditId)}
      successMessage={REDACT.done}
      run={async ({ reason, requestKey, code }) =>
        adminOutcome(
          await redactAuditReason({ auditId, why: reason ?? '', requestKey, code: code ?? '' }),
        )
      }
    />
  )
}
