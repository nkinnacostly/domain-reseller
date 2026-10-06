'use client'

import { RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useAction } from 'next-safe-action/hooks'
import { useState } from 'react'
import { ConfirmDialog, dangerButtonClass } from '@/components/common/confirm-dialog'
import { FormMessage } from '@/components/common/form-parts'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { checkDomain, removeDomain, retryDomain } from '../actions/domains'

/**
 * What can be done to one domain (MAIL-SPEC §5): "Check now" (any member),
 * try a failed one again, remove it (owners, admins and developers). Each has
 * its pressed and pending states, and says what happened (S11, S12).
 */

const secondaryButton =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-border bg-background px-5 text-sm font-medium transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60'

const CHECKED: Record<string, string> = {
  verified: 'Checked: Amazon SES has verified this domain.',
  pending:
    'Checked: Amazon SES has not seen the DKIM records yet. We keep checking every 10 minutes.',
  waiting:
    'Checked: your account’s sending set-up is still being made. We finish it in a few minutes.',
  busy: 'A check ran a moment ago, or is running now. Refresh in a minute.',
  later: 'We could not reach Amazon SES just now. We keep checking every 10 minutes.',
  error: 'Amazon SES did not answer just now. We keep checking every 10 minutes.',
}

// The actions revalidate the domains pages themselves (revalidatePath), so
// the page re-renders with the action's answer: no second refresh to wait on.

export function CheckNowButton({ accountId, domainId }: { accountId: string; domainId: string }) {
  const check = useAction(checkDomain)
  const outcome = check.result.data?.outcome
  const said = outcome
    ? (CHECKED[outcome] ?? 'Checked.')
    : check.result.serverError
      ? check.result.serverError
      : null
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={check.isPending}
        aria-busy={check.isPending || undefined}
        onClick={() => check.execute({ accountId, domainId })}
        className={cn(secondaryButton)}
      >
        {check.isPending ? (
          <Spinner className="size-4" aria-hidden="true" />
        ) : (
          <RefreshCw className="size-4" aria-hidden="true" />
        )}
        {check.isPending ? 'Checking…' : 'Check now'}
      </button>
      <p role="status" className="min-h-5 text-pretty text-sm text-muted-foreground">
        {said}
      </p>
    </div>
  )
}

export function RetryButton({ accountId, domainId }: { accountId: string; domainId: string }) {
  const retry = useAction(retryDomain)
  const data = retry.result.data
  const error = (data && 'error' in data ? data.error : null) ?? retry.result.serverError ?? null
  return (
    <div className="space-y-2">
      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
      <button
        type="button"
        disabled={retry.isPending}
        aria-busy={retry.isPending || undefined}
        onClick={() => retry.execute({ accountId, domainId })}
        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70"
      >
        {retry.isPending ? (
          <Spinner className="size-4" aria-hidden="true" />
        ) : (
          <RotateCcw className="size-4" aria-hidden="true" />
        )}
        {retry.isPending ? 'Starting again…' : 'Try again'}
      </button>
    </div>
  )
}

export function RemoveDomainButton({
  accountId,
  domainId,
  name,
}: {
  accountId: string
  domainId: string
  name: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const remove = useAction(removeDomain, {
    onSuccess: ({ data }) => {
      if (data && 'ok' in data) {
        setOpen(false)
        router.push('/dashboard/domains')
      }
    },
  })
  const data = remove.result.data
  const error = (data && 'error' in data ? data.error : null) ?? remove.result.serverError ?? null
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) remove.reset()
        setOpen(next)
      }}
      trigger={
        <button type="button" className={dangerButtonClass}>
          <Trash2 className="size-4" aria-hidden="true" />
          Remove domain
        </button>
      }
      title={`Remove ${name}?`}
      description={
        <>
          <p>
            Email can no longer be sent from any address at {name}, and API keys limited to it stop
            working. Its identity is deleted from Amazon SES.
          </p>
          <p className="mt-2">
            To send from it again you would add it again, with new DKIM records. Emails already sent
            stay in your log.
          </p>
        </>
      }
      confirmLabel="Remove domain"
      pendingLabel="Removing…"
      pending={remove.isPending}
      error={error}
      onConfirm={() => remove.execute({ accountId, domainId })}
    />
  )
}
