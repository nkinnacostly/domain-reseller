'use client'

import { Check, Copy } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useAction } from 'next-safe-action/hooks'
import { useId, useState } from 'react'
import {
  describedBy,
  Field,
  FormMessage,
  fieldError,
  inputClass,
  onSubmitWith,
  SubmitButton,
} from '@/components/common/form-parts'
import type { MemberRole } from '@/lib/safe-action'
import { cn } from '@/lib/utils'
import { createInvite, revokeInvite } from '../actions/members'
import { type GrantableRole, grantableBy, ROLE_LABEL, ROLE_SUMMARY } from '../lib/roles'
import type { PendingInvite } from '../queries/members'

const day = new Intl.DateTimeFormat('en-NG', { dateStyle: 'medium', timeZone: 'Africa/Lagos' })

/**
 * Inviting someone (MAIL-SPEC §9: a hashed token, seven days). We do not email
 * invites yet, and say so: the link is shown once, here, for the inviter to
 * copy and send. It is held only in this component's state, and gone once
 * the page is left.
 */
export function InviteForm({ accountId, myRole }: { accountId: string; myRole: MemberRole }) {
  const id = useId()
  const router = useRouter()
  const invite = useAction(createInvite, { onSuccess: () => router.refresh() })
  const [sentTo, setSentTo] = useState<string | null>(null)
  const roles = grantableBy(myRole)
  const data = invite.result.data
  const errors = invite.result.validationErrors

  if (data && 'link' in data) {
    return (
      <InviteLink
        link={data.link}
        email={sentTo}
        expiresAt={data.expiresAt}
        emailed={data.emailed}
        onAnother={() => {
          invite.reset()
          setSentTo(null)
        }}
      />
    )
  }

  return (
    <form
      aria-label="Invite someone"
      className="space-y-4"
      noValidate
      onSubmit={onSubmitWith((form) => {
        const email = String(form.get('email') ?? '')
        setSentTo(email.trim().toLowerCase())
        invite.execute({
          accountId,
          email,
          role: String(form.get('role') ?? '') as GrantableRole,
        })
      })}
    >
      {data && 'error' in data ? <FormMessage tone="error">{data.error}</FormMessage> : null}
      {invite.result.serverError ? (
        <FormMessage tone="error">{invite.result.serverError}</FormMessage>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-[1fr_14rem]">
        <Field id={`${id}-email`} label="Their email" error={fieldError(errors, 'email')}>
          <input
            id={`${id}-email`}
            name="email"
            type="email"
            inputMode="email"
            autoComplete="off"
            required
            aria-invalid={fieldError(errors, 'email') ? true : undefined}
            aria-describedby={describedBy(`${id}-email`, fieldError(errors, 'email'))}
            className={inputClass}
          />
        </Field>
        <Field id={`${id}-role`} label="Role" error={fieldError(errors, 'role')}>
          <select
            id={`${id}-role`}
            name="role"
            defaultValue={roles.includes('developer') ? 'developer' : roles[0]}
            className={inputClass}
          >
            {roles.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABEL[role]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <ul className="space-y-1 text-xs/5 text-muted-foreground">
        {roles.map((role) => (
          <li key={role}>
            <span className="font-medium text-foreground">{ROLE_LABEL[role]}:</span>{' '}
            {ROLE_SUMMARY[role]}
          </li>
        ))}
      </ul>
      <SubmitButton
        pending={invite.isPending}
        pendingLabel="Sending the invite…"
        className="sm:w-auto"
      >
        Send invite
      </SubmitButton>
    </form>
  )
}

function InviteLink({
  link,
  email,
  expiresAt,
  emailed,
  onAnother,
}: {
  link: string
  email: string | null
  expiresAt: string
  /** The invite email was queued (migration 58); otherwise the inviter sends the link. */
  emailed: boolean
  onAnother: () => void
}) {
  const id = useId()
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null)
  const expires = expiresAt ? day.format(new Date(expiresAt)) : 'in seven days'

  return (
    <div className="space-y-4">
      <FormMessage tone="success">
        <p className="font-medium">
          {emailed
            ? `Invite sent${email ? ` to ${email}` : ''}`
            : `Invite ready${email ? ` for ${email}` : ''}`}
        </p>
        <p>
          {emailed
            ? 'We have emailed them this link. You can copy it too, to send another way.'
            : 'We could not email it just now: copy this link and send it to them yourself.'}{' '}
          It works once, only for that address, until {expires}. It is shown only now.
        </p>
      </FormMessage>
      <div>
        <label htmlFor={`${id}-link`} className="text-sm font-medium">
          Invite link
        </label>
        <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
          <input
            id={`${id}-link`}
            readOnly
            value={link}
            onFocus={(event) => event.currentTarget.select()}
            className={cn(inputClass, 'font-mono text-sm')}
          />
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link)
                setCopied('yes')
              } catch {
                setCopied('failed')
              }
            }}
            className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
          >
            {copied === 'yes' ? (
              <Check className="size-4" aria-hidden="true" />
            ) : (
              <Copy className="size-4" aria-hidden="true" />
            )}
            {copied === 'yes' ? 'Copied' : 'Copy link'}
          </button>
        </div>
        <p role="status" className="mt-1.5 min-h-5 text-xs text-muted-foreground">
          {copied === 'failed' ? 'Copying did not work here: select the link and copy it.' : ''}
        </p>
      </div>
      <button
        type="button"
        onClick={onAnother}
        className="inline-flex min-h-11 items-center rounded-full border border-border bg-background px-5 text-sm font-medium transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
      >
        Invite someone else
      </button>
    </div>
  )
}

/** Invites still waiting: who, as what, until when — and a way to revoke each. */
export function PendingInvites({
  accountId,
  invites,
  myRole,
}: {
  accountId: string
  invites: PendingInvite[]
  myRole: MemberRole
}) {
  if (invites.length === 0) {
    return <p className="text-sm text-muted-foreground">No invites are waiting.</p>
  }
  return (
    <ul className="divide-y divide-border rounded-3xl border border-border bg-card">
      {invites.map((invite) => (
        <PendingInviteRow
          key={invite.id}
          accountId={accountId}
          invite={invite}
          canRevoke={grantableBy(myRole).includes(invite.role)}
        />
      ))}
    </ul>
  )
}

function PendingInviteRow({
  accountId,
  invite,
  canRevoke,
}: {
  accountId: string
  invite: PendingInvite
  canRevoke: boolean
}) {
  const router = useRouter()
  const revoke = useAction(revokeInvite, { onSuccess: () => router.refresh() })
  const error =
    (revoke.result.data && 'error' in revoke.result.data ? revoke.result.data.error : null) ??
    revoke.result.serverError
  return (
    <li data-invite={invite.email} className="space-y-2 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{invite.email}</p>
          <p className="text-sm text-muted-foreground">
            {ROLE_LABEL[invite.role]} · waiting until {day.format(new Date(invite.expiresAt))}
          </p>
        </div>
        {canRevoke ? (
          <form onSubmit={onSubmitWith(() => revoke.execute({ accountId, inviteId: invite.id }))}>
            <SubmitButton
              pending={revoke.isPending}
              pendingLabel="Revoking…"
              variant="secondary"
              className="w-auto"
            >
              Revoke<span className="sr-only"> the invite for {invite.email}</span>
            </SubmitButton>
          </form>
        ) : null}
      </div>
      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
    </li>
  )
}
