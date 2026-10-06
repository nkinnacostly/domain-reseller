'use client'

import { useRouter } from 'next/navigation'
import { useAction } from 'next-safe-action/hooks'
import { useId, useState } from 'react'
import { ConfirmDialog, dangerButtonClass } from '@/components/common/confirm-dialog'
import {
  describedBy,
  Field,
  FormMessage,
  fieldError,
  inputClass,
  onSubmitWith,
} from '@/components/common/form-parts'
import { leaveAccount, transferOwnership } from '../actions/members'
import { memberName } from '../lib/people'
import { ROLE_LABEL } from '../lib/roles'
import type { Member } from '../queries/members'

/** Leaving (anyone but the owner): asked once more, then done. */
export function LeaveAccount({
  accountId,
  accountName,
}: {
  accountId: string
  accountName: string
}) {
  const [open, setOpen] = useState(false)
  const leave = useAction(leaveAccount, {
    onSuccess: ({ data }) => {
      if (data && 'ok' in data) window.location.assign('/dashboard')
    },
  })
  const error =
    (leave.result.data && 'error' in leave.result.data ? leave.result.data.error : null) ??
    leave.result.serverError
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) leave.reset()
        setOpen(next)
      }}
      trigger={
        <button type="button" className={dangerButtonClass}>
          Leave this account
        </button>
      }
      title={`Leave ${accountName}?`}
      description="You lose access to it at once. To come back, an owner or admin has to invite you again."
      confirmLabel="Leave the account"
      pendingLabel="Leaving…"
      pending={leave.isPending || Boolean(leave.result.data && 'ok' in leave.result.data)}
      error={error}
      onConfirm={() => leave.execute({ accountId })}
    />
  )
}

/**
 * Handing the account over (owner only): to another member, confirmed by
 * typing the account's name, then asked once more. The owner stays, as an
 * admin. With two-factor on, SQL wants a code entered this session.
 */
export function TransferOwnership({
  accountId,
  accountName,
  candidates,
}: {
  accountId: string
  accountName: string
  candidates: Member[]
}) {
  const id = useId()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState<{ userId: string; confirmName: string } | null>(null)
  const transfer = useAction(transferOwnership, {
    onSuccess: ({ data }) => {
      if (data && 'ok' in data) {
        setOpen(false)
        router.refresh()
      }
    },
  })
  const errors = transfer.result.validationErrors
  const error =
    (transfer.result.data && 'error' in transfer.result.data ? transfer.result.data.error : null) ??
    transfer.result.serverError

  if (candidates.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        To hand the account over, invite the person first. Once they have joined, they appear here.
      </p>
    )
  }
  if (transfer.result.data && 'ok' in transfer.result.data) {
    return <FormMessage tone="success">Done. You are now an admin of this account.</FormMessage>
  }
  const chosen = candidates.find((member) => member.userId === choice?.userId)

  return (
    <form
      aria-label="Hand the account over"
      className="max-w-xl space-y-4"
      noValidate
      onSubmit={onSubmitWith((form) => {
        setChoice({
          userId: String(form.get('userId') ?? ''),
          confirmName: String(form.get('confirmName') ?? ''),
        })
        transfer.reset()
        setOpen(true)
      })}
    >
      <Field id={`${id}-member`} label="New owner">
        <select id={`${id}-member`} name="userId" className={inputClass}>
          {candidates.map((member) => (
            <option key={member.userId} value={member.userId}>
              {memberName(member)} ({ROLE_LABEL[member.role]})
            </option>
          ))}
        </select>
      </Field>
      <Field
        id={`${id}-confirm`}
        label={`Type the account’s name, ${accountName}, to confirm`}
        error={fieldError(errors, 'confirmName')}
      >
        <input
          id={`${id}-confirm`}
          name="confirmName"
          autoComplete="off"
          aria-invalid={fieldError(errors, 'confirmName') ? true : undefined}
          aria-describedby={describedBy(`${id}-confirm`, fieldError(errors, 'confirmName'))}
          className={inputClass}
        />
      </Field>
      <button type="submit" className={dangerButtonClass}>
        Hand the account over
      </button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Make ${chosen ? memberName(chosen) : 'them'} the owner?`}
        description="They will manage the account and its admins, and you will become an admin. Only they can hand it back."
        confirmLabel="Hand it over"
        pendingLabel="Handing over…"
        pending={transfer.isPending}
        error={error}
        onConfirm={() => {
          if (choice) transfer.execute({ accountId, ...choice })
        }}
      />
    </form>
  )
}
