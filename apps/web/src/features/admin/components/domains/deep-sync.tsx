'use client'

import { queueDeepSync } from '@/features/admin/actions/domains'
import { ConfirmAction } from '@/features/admin/components/confirm-action'
import { DEEP_SYNC } from '@/features/admin/lib/domains-copy'
import { adminOutcome } from '@/features/admin/lib/errors'

/**
 * "Queue a deep sync" (§5.2 B9, D14): the next deep sync reads this domain
 * from the registry and corrects our record. Standard tier, reason optional;
 * SQL refuses a domain that is not live (NOT_SYNCABLE) or a side no gateway
 * is reading (NO_GATEWAY), and records the refusal.
 */
export function DeepSyncButton({
  domainId,
  name,
  returnTo,
}: {
  domainId: string
  name: string
  returnTo: string
}) {
  return (
    <ConfirmAction
      trigger={DEEP_SYNC.trigger}
      title={DEEP_SYNC.title(name)}
      body={DEEP_SYNC.body}
      confirmLabel={DEEP_SYNC.confirm}
      cancelLabel={DEEP_SYNC.cancel}
      reason="optional"
      returnTo={returnTo}
      successMessage={DEEP_SYNC.done}
      run={async (extra) =>
        adminOutcome(
          await queueDeepSync({
            domainId,
            reason: extra.reason,
            requestKey: extra.requestKey,
          }),
        )
      }
    />
  )
}
