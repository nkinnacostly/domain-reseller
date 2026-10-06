'use client'

import { useRouter } from 'next/navigation'
import { useAction } from 'next-safe-action/hooks'
import { Spinner } from '@/components/ui/spinner'
import { resendDelivery } from '../actions/webhooks'

/**
 * "Resend" (MAIL-SPEC §10): the same message, with the same webhook-id, as
 * a new delivery with its own retries. Pressed and pending states (S12): a
 * second press while it runs does nothing.
 */
export function ResendButton({
  accountId,
  deliveryId,
  label,
}: {
  accountId: string
  deliveryId: number
  /** What is being resent, for screen readers: "Resend: the Delivered event of 10:42". */
  label: string
}) {
  const router = useRouter()
  const resend = useAction(resendDelivery, {
    onSuccess: ({ data }) => {
      if (data && 'ok' in data) router.refresh()
    },
  })
  const data = resend.result.data
  const error = (data && 'error' in data ? data.error : null) ?? resend.result.serverError
  const done = Boolean(data && 'ok' in data)

  return (
    <div className="space-y-1">
      <button
        type="button"
        disabled={resend.isPending || done}
        aria-busy={resend.isPending || undefined}
        onClick={() => resend.execute({ accountId, deliveryId })}
        className="inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-full border border-border bg-background px-4 text-sm font-medium transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {resend.isPending ? <Spinner className="size-4" aria-hidden="true" /> : null}
        {done ? 'Queued' : resend.isPending ? 'Resending…' : 'Resend'}
        <span className="sr-only">: {label}</span>
      </button>
      <p role="status" className="max-w-56 text-xs text-tone-danger-foreground">
        {error ?? ''}
      </p>
    </div>
  )
}
