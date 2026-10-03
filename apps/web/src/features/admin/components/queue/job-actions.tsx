'use client'

import { failJob, failSslJob, retryJob, retrySslJob } from '@/features/admin/actions/jobs'
import { ConfirmAction, type ConfirmExtra } from '@/features/admin/components/confirm-action'
import { adminOutcome } from '@/features/admin/lib/errors'
import type { FailCopy, RetryCopy } from '@/features/admin/lib/jobs-copy'

/**
 * Retry and Fail for one job (ADMIN-SPEC §5.2 B4). Both are money actions:
 * the dialog asks for a reason and the code from the authenticator app, and
 * Fail also for the domain typed back. The words come from the server
 * (`lib/jobs-copy.ts`), worked out from the job's own facts.
 */
export function JobActions({
  jobId,
  certificate,
  retry,
  fail,
  typeToConfirm,
  returnTo,
}: {
  jobId: string
  /** A certificate job: the certificate wrappers answer. */
  certificate: boolean
  retry: RetryCopy | null
  fail: FailCopy | null
  typeToConfirm: string
  returnTo: string
}) {
  const input = (extra: ConfirmExtra) => ({
    jobId,
    reason: extra.reason ?? '',
    requestKey: extra.requestKey,
    code: extra.code ?? '',
  })
  if (!retry && !fail) return null
  return (
    <div className="flex flex-wrap gap-3">
      {retry ? (
        <ConfirmAction
          trigger="Retry"
          title={retry.title}
          body={retry.body}
          confirmLabel={retry.confirmLabel}
          cancelLabel={retry.cancelLabel}
          reason="required"
          needsCode
          returnTo={returnTo}
          successMessage={retry.done}
          run={async (extra) =>
            adminOutcome(await (certificate ? retrySslJob : retryJob)(input(extra)))
          }
        />
      ) : null}
      {fail ? (
        <ConfirmAction
          trigger={fail.trigger}
          title={fail.title}
          body={fail.body}
          confirmLabel={fail.confirmLabel}
          reason="required"
          typeToConfirm={typeToConfirm}
          needsCode
          destructive
          returnTo={returnTo}
          successMessage={fail.done}
          run={async (extra) =>
            adminOutcome(await (certificate ? failSslJob : failJob)(input(extra)))
          }
        />
      ) : null}
    </div>
  )
}
