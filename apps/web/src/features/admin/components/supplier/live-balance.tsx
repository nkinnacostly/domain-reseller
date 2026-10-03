'use client'

import type { AdminSupplierBalance } from '@dr/shared/admin'
import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { ActionError, QUIET_BUTTON } from '@/components/common/action-parts'
import { FormMessage } from '@/components/common/form-parts'
import { Spinner } from '@/components/ui/spinner'
import { readLiveBalance } from '@/features/admin/actions/supplier-live'
import { adminOutcome } from '@/features/admin/lib/errors'
import { LIVE_BALANCE } from '@/features/admin/lib/supplier-copy'
import { liveBalanceDifference, liveBalanceLine } from '@/features/admin/lib/supplier-float'

/**
 * "Read live balance" (docs/ADMIN-SPEC.md §5.2 B6): one press, one audited
 * read through the gateway — never on render (D10, D22). The answer sits
 * beside the latest snapshot, so a difference shows at a glance.
 */
export function LiveBalance({
  snapshotCents,
  takenAt,
}: {
  snapshotCents: number | null
  takenAt: string | null
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [read, setRead] = useState<{ balance: AdminSupplierBalance; auditId: number } | null>(null)

  async function onRead() {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      const result = adminOutcome(await readLiveBalance({}))
      if (result.ok && result.data) {
        setRead({ balance: result.data, auditId: result.auditId })
      } else if (!result.ok) {
        setError(result.message)
      }
    } catch {
      setError("We couldn't reach the dashboard's server. Try again.")
    } finally {
      setPending(false)
    }
  }

  const now = new Date()
  return (
    <div className="space-y-3">
      <p className="max-w-2xl text-sm text-muted-foreground">{LIVE_BALANCE.intro}</p>
      <button
        type="button"
        onClick={onRead}
        disabled={pending}
        aria-busy={pending || undefined}
        className={QUIET_BUTTON}
      >
        {pending ? (
          <Spinner className="size-4" aria-hidden="true" />
        ) : (
          <RefreshCw className="size-4" aria-hidden="true" />
        )}
        {pending ? LIVE_BALANCE.pending : LIVE_BALANCE.button}
      </button>
      <ActionError message={error} returnTo="/admin/supplier" />
      {read ? (
        <FormMessage tone="success">
          <span data-live-balance className="font-medium tabular-nums">
            {liveBalanceLine(read.balance, { balanceCents: snapshotCents, takenAt }, now)}
          </span>
          {(() => {
            const moved = liveBalanceDifference(read.balance.balanceCents, snapshotCents)
            return moved ? <span className="block text-muted-foreground">{moved}</span> : null
          })()}
          <span className="block text-xs text-muted-foreground">Audit entry #{read.auditId}</span>
        </FormMessage>
      ) : null}
    </div>
  )
}
