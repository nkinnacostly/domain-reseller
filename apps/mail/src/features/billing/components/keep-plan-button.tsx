'use client'

import { useRouter } from 'next/navigation'
import { useAction } from 'next-safe-action/hooks'
import { FormMessage } from '@/components/common/form-parts'
import { Spinner } from '@/components/ui/spinner'
import { keepPlan } from '../actions/billing'
import { BILLING_FALLBACK } from '../lib/words'
import { secondaryButtonClass } from './styles'

/** Withdraws a scheduled change: Flutterwave charges the card for this plan again. */
export function KeepPlanButton({ accountId, planName }: { accountId: string; planName: string }) {
  const router = useRouter()
  const keep = useAction(keepPlan, {
    onSuccess: ({ data }) => {
      if (data && 'ok' in data) router.refresh()
    },
  })
  const data = keep.result.data as { error?: string } | undefined
  const error =
    data?.error ??
    keep.result.serverError ??
    (keep.result.validationErrors ? BILLING_FALLBACK : null)
  return (
    <div className="space-y-3">
      <button
        type="button"
        disabled={keep.isPending}
        aria-busy={keep.isPending || undefined}
        onClick={() => keep.execute({ accountId })}
        className={secondaryButtonClass}
      >
        {keep.isPending ? (
          <>
            <Spinner className="size-4" aria-hidden="true" />
            Keeping {planName}…
          </>
        ) : (
          `Keep ${planName}`
        )}
      </button>
      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
    </div>
  )
}
