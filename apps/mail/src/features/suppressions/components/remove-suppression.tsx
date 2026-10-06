'use client'

import { useRouter } from 'next/navigation'
import { useAction } from 'next-safe-action/hooks'
import { useState } from 'react'
import { ConfirmDialog, dangerButtonClass } from '@/components/common/confirm-dialog'
import { removeSuppression } from '../actions/suppressions'
import { REASON, type SuppressionReason } from '../lib/words'

/**
 * "Remove" with its warning (MAIL-SPEC §10 Suppressions): sending again to
 * an address that bounced or complained is how an account's reputation —
 * and its sending — is lost. The dialog says so, and stays open with the
 * refusal if the removal fails.
 */
export function RemoveSuppression({
  accountId,
  suppressionId,
  address,
  reason,
}: {
  accountId: string
  suppressionId: number
  address: string
  reason: SuppressionReason
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const remove = useAction(removeSuppression, {
    onSuccess: ({ data }) => {
      if (data && 'ok' in data) {
        setOpen(false)
        router.refresh()
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
          Remove<span className="sr-only">: {address}</span>
        </button>
      }
      title="Remove this address from the list?"
      description={
        <>
          <p>
            <span className="break-all font-medium text-foreground">{address}</span> is on the list
            because it was{' '}
            {reason === 'complaint' ? 'marked as spam' : REASON[reason].label.toLowerCase()}. Once
            removed, this account’s emails go to it again.
          </p>
          <p className="mt-2">
            {reason === 'complaint'
              ? 'Sending to someone who reported you as spam raises your complaint rate.'
              : 'If it bounces again, it raises your bounce rate.'}{' '}
            Too many bounces or complaints pause sending for the whole account. Remove it only if
            you know the address now works and wants your email.
          </p>
        </>
      }
      confirmLabel="Remove from the list"
      pendingLabel="Removing…"
      pending={remove.isPending}
      error={error}
      onConfirm={() => remove.execute({ accountId, suppressionId })}
    />
  )
}
