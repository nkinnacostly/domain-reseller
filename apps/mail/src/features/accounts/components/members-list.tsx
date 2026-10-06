'use client'

import { useRouter } from 'next/navigation'
import { useAction } from 'next-safe-action/hooks'
import { useId, useState } from 'react'
import { ConfirmDialog, dangerButtonClass } from '@/components/common/confirm-dialog'
import { FormMessage, inputClass, onSubmitWith, SubmitButton } from '@/components/common/form-parts'
import type { MemberRole } from '@/lib/safe-action'
import { cn } from '@/lib/utils'
import { changeMemberRole, removeMember } from '../actions/members'
import { memberName } from '../lib/people'
import { canManage, grantableBy, ROLE_LABEL } from '../lib/roles'
import type { Member } from '../queries/members'

const joined = new Intl.DateTimeFormat('en-NG', { dateStyle: 'medium', timeZone: 'Africa/Lagos' })

/**
 * The account's members (MAIL-SPEC §10 Settings: "members and roles"). Each
 * row says who and what role; owners and admins see the changes their role
 * may make (SQL decides again, migration 46).
 */
export function MembersList({
  accountId,
  members,
  me,
  myRole,
}: {
  accountId: string
  members: Member[]
  me: string
  myRole: MemberRole
}) {
  return (
    <ul className="divide-y divide-border rounded-3xl border border-border bg-card">
      {members.map((member) => (
        <MemberRow
          key={member.userId}
          accountId={accountId}
          member={member}
          isMe={member.userId === me}
          myRole={myRole}
        />
      ))}
    </ul>
  )
}

function MemberRow({
  accountId,
  member,
  isMe,
  myRole,
}: {
  accountId: string
  member: Member
  isMe: boolean
  myRole: MemberRole
}) {
  const id = useId()
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const change = useAction(changeMemberRole, { onSuccess: () => router.refresh() })
  const remove = useAction(removeMember, {
    onSuccess: ({ data }) => {
      if (data && 'ok' in data) {
        setConfirming(false)
        router.refresh()
      }
    },
  })
  const manageable = canManage(myRole, member.role, isMe)
  const name = memberName(member)
  const changeError =
    (change.result.data && 'error' in change.result.data ? change.result.data.error : null) ??
    change.result.serverError
  const removeError =
    (remove.result.data && 'error' in remove.result.data ? remove.result.data.error : null) ??
    remove.result.serverError

  return (
    <li data-member={member.email ?? member.userId} className="space-y-3 px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="truncate font-medium">
            {name}
            {isMe ? (
              <span className="ml-2 text-xs font-normal text-muted-foreground">(you)</span>
            ) : null}
          </p>
          {member.name && member.email ? (
            <p className="truncate text-sm text-muted-foreground">{member.email}</p>
          ) : null}
        </div>
        <p className="text-sm">
          <span className="font-medium">{ROLE_LABEL[member.role]}</span>
          <span className="text-muted-foreground">
            {' '}
            · joined {joined.format(new Date(member.joinedAt))}
          </span>
        </p>
      </div>

      {manageable ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <form
            aria-label={`Change ${name}’s role`}
            className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={onSubmitWith((form) =>
              change.execute({
                accountId,
                userId: member.userId,
                role: String(form.get('role') ?? '') as 'admin' | 'developer' | 'viewer',
              }),
            )}
          >
            <div className="sm:w-56">
              <label htmlFor={`${id}-role`} className="text-sm font-medium">
                Role
              </label>
              <select
                id={`${id}-role`}
                name="role"
                defaultValue={member.role}
                className={cn(inputClass, 'mt-1.5')}
              >
                {grantableBy(myRole).map((role) => (
                  <option key={role} value={role}>
                    {ROLE_LABEL[role]}
                  </option>
                ))}
              </select>
            </div>
            <SubmitButton
              pending={change.isPending}
              pendingLabel="Saving…"
              variant="secondary"
              className="sm:w-auto"
            >
              Change role
            </SubmitButton>
          </form>
          <ConfirmDialog
            open={confirming}
            onOpenChange={(open) => {
              if (!open) remove.reset()
              setConfirming(open)
            }}
            trigger={
              <button type="button" className={dangerButtonClass}>
                Remove
              </button>
            }
            title={`Remove ${name}?`}
            description={`They lose access to this account at once. Its emails, keys and domains stay. You can invite them again later.`}
            confirmLabel="Remove from the account"
            pendingLabel="Removing…"
            pending={remove.isPending}
            error={removeError}
            onConfirm={() => remove.execute({ accountId, userId: member.userId })}
          />
        </div>
      ) : null}
      {changeError ? <FormMessage tone="error">{changeError}</FormMessage> : null}
      {change.result.data && 'ok' in change.result.data ? (
        <FormMessage tone="success">Role changed.</FormMessage>
      ) : null}
    </li>
  )
}
