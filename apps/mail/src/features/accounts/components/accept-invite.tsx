'use client'

import { useAction } from 'next-safe-action/hooks'
import { FormMessage, onSubmitWith, SubmitButton } from '@/components/common/form-parts'
import { acceptInvite } from '../actions/members'

/** Joins the account the invite names (MAIL-SPEC §9); the dashboard opens on it. */
export function AcceptInvite({ token, accountName }: { token: string; accountName: string }) {
  const accept = useAction(acceptInvite, {
    onSuccess: ({ data }) => {
      if (data && 'ok' in data) window.location.assign('/dashboard')
    },
  })
  const joined = Boolean(accept.result.data && 'ok' in accept.result.data)
  const error =
    (accept.result.data && 'error' in accept.result.data ? accept.result.data.error : null) ??
    accept.result.serverError
  return (
    <form
      aria-label="Accept the invite"
      className="space-y-4"
      onSubmit={onSubmitWith(() => accept.execute({ token }))}
    >
      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
      <SubmitButton pending={accept.isPending || joined} pendingLabel="Joining…">
        Join {accountName}
      </SubmitButton>
    </form>
  )
}
