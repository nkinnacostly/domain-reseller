'use client'

import { useId, useState } from 'react'
import { inputClass } from '@/components/common/form-parts'
import {
  approveAccount,
  overrideCaps,
  pauseAccount,
  rejectAccount,
  resumeAccount,
} from '@/features/admin/actions/accounts'
import { type AdminRole, canAct } from '@/features/admin/lib/actions'
import { adminOutcome } from '@/features/admin/lib/errors'
import { findingKindOf } from '@/features/admin/lib/format'
import { cn } from '@/lib/utils'
import { ConfirmAction, DANGER_BUTTON, PRIMARY_BUTTON, QUIET_BUTTON } from './confirm-action'

/**
 * What an admin may do to one account (MAIL-SPEC §7.2, §7.4, §10, MR5),
 * offered by role — SQL decides every one again. Approve and reject while it
 * is in the sandbox; pause while it can send; resume while paused (the owner,
 * with a code, naming the finding read); caps while it is open.
 */

export type AccountForActions = {
  id: string
  name: string
  tenant: string
  state: 'sandbox' | 'active' | 'paused' | 'closed'
  sesStatus: string
  dailyOverride: number | null
  monthlyOverride: number | null
}

export type OpenPauseFinding = { id: number; kind: string } | null

const parseCap = (text: string): number | null | undefined => {
  const trimmed = text.trim().replace(/[,\s]/g, '')
  if (trimmed === '') return null
  if (!/^\d{1,8}$/.test(trimmed)) return undefined
  const n = Number(trimmed)
  return n >= 1 ? n : undefined
}

function CapField({
  id,
  label,
  value,
  onChange,
  hint,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  hint: string
}) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode="numeric"
        autoComplete="off"
        aria-describedby={`${id}-hint`}
        className={cn(inputClass, 'mt-1.5')}
      />
      <p id={`${id}-hint`} className="mt-1.5 text-xs text-muted-foreground">
        {hint}
      </p>
    </div>
  )
}

function CapsAction({ account }: { account: AccountForActions }) {
  const id = useId()
  const [daily, setDaily] = useState(
    account.dailyOverride === null ? '' : String(account.dailyOverride),
  )
  const [monthly, setMonthly] = useState(
    account.monthlyOverride === null ? '' : String(account.monthlyOverride),
  )
  const dailyCap = parseCap(daily)
  const monthlyCap = parseCap(monthly)
  return (
    <ConfirmAction
      trigger="Change caps"
      triggerClassName={QUIET_BUTTON}
      title={`Change ${account.name}’s caps`}
      body={
        <p>
          The account’s own daily and monthly caps, in recipients. Leave one empty to keep the
          plan’s. A daily cap ends the warm-up’s doubling for this account.
        </p>
      }
      confirmLabel="Save the caps"
      needsCode
      canConfirm={dailyCap !== undefined && monthlyCap !== undefined}
      successMessage="The caps are saved."
      run={async (input) => {
        if (dailyCap === undefined || monthlyCap === undefined || !input.code) {
          return {
            ok: false,
            code: 'OUT_OF_RANGE',
            message: 'Each cap is a whole number of at least 1, or empty.',
          }
        }
        return adminOutcome(
          await overrideCaps({
            accountId: account.id,
            dailyCap,
            monthlyCap,
            reason: input.reason,
            requestKey: input.requestKey,
            code: input.code,
          }),
        )
      }}
    >
      <CapField
        id={`${id}-daily`}
        label="Daily cap"
        value={daily}
        onChange={setDaily}
        hint={
          dailyCap === undefined
            ? 'A whole number of at least 1, or empty.'
            : 'Empty keeps the plan’s.'
        }
      />
      <CapField
        id={`${id}-monthly`}
        label="Monthly cap"
        value={monthly}
        onChange={setMonthly}
        hint={
          monthlyCap === undefined
            ? 'A whole number of at least 1, or empty.'
            : 'Empty keeps the plan’s.'
        }
      />
    </ConfirmAction>
  )
}

export function AccountActions({
  account,
  admin,
  openPauseFinding,
}: {
  account: AccountForActions
  admin: { role: AdminRole; testOnly: boolean }
  openPauseFinding: OpenPauseFinding
}) {
  const actions: React.ReactNode[] = []

  if (account.state === 'sandbox' && canAct(admin, 'mail.approve')) {
    actions.push(
      <ConfirmAction
        key="approve"
        trigger="Approve"
        title={`Approve ${account.name}`}
        body={
          <p>
            It leaves the sandbox and may send to anyone, starting its warm-up: a daily cap that
            doubles each day while its bounces and complaints stay low.
          </p>
        }
        confirmLabel="Approve the account"
        successMessage="Approved: the account is active and warming up."
        run={async (input) =>
          adminOutcome(
            await approveAccount({
              accountId: account.id,
              reason: input.reason,
              requestKey: input.requestKey,
            }),
          )
        }
      />,
    )
  }
  if (account.state === 'sandbox' && canAct(admin, 'mail.reject')) {
    actions.push(
      <ConfirmAction
        key="reject"
        trigger="Reject"
        triggerClassName={DANGER_BUTTON}
        destructive
        title={`Reject ${account.name}`}
        body={
          <p>
            The account is closed: nothing can be sent from it, and it is not reopened from here.
          </p>
        }
        confirmLabel="Reject and close"
        successMessage="Rejected: the account is closed."
        run={async (input) =>
          adminOutcome(
            await rejectAccount({
              accountId: account.id,
              reason: input.reason,
              requestKey: input.requestKey,
            }),
          )
        }
      />,
    )
  }
  if ((account.state === 'sandbox' || account.state === 'active') && canAct(admin, 'mail.pause')) {
    actions.push(
      <ConfirmAction
        key="pause"
        trigger="Pause sending"
        triggerClassName={DANGER_BUTTON}
        destructive
        title={`Pause ${account.name}`}
        body={
          <p>
            Our gate refuses its email at once, and SES is told to pause its tenant (
            {account.tenant}). Only the owner can resume it, with a code (MR5).
          </p>
        }
        confirmLabel="Pause sending"
        successMessage="Paused: nothing is sent from this account."
        run={async (input) =>
          adminOutcome(
            await pauseAccount({
              accountId: account.id,
              reason: input.reason,
              requestKey: input.requestKey,
            }),
          )
        }
      />,
    )
  }
  if (account.state === 'paused' && canAct(admin, 'mail.resume')) {
    actions.push(
      <ConfirmAction
        key="resume"
        trigger="Resume sending"
        triggerClassName={PRIMARY_BUTTON}
        title={`Resume ${account.name}`}
        body={
          <>
            <p>
              {openPauseFinding
                ? `You are resuming after reading the finding “${findingKindOf(openPauseFinding.kind)}”. It closes, with any other open pause.`
                : 'No pause finding is open on this account.'}
            </p>
            <p>
              The account goes back to where it was; an active account starts its warm-up again.
              {account.sesStatus === 'disabled'
                ? ' SES reports the tenant paused: if AWS paused it, not us, it is resumed through an AWS support case instead.'
                : ''}
            </p>
          </>
        }
        confirmLabel="Resume sending"
        needsCode
        successMessage="Resumed: the account can send again once SES confirms."
        run={async (input) =>
          adminOutcome(
            await resumeAccount({
              accountId: account.id,
              findingId: openPauseFinding?.id ?? null,
              reason: input.reason,
              requestKey: input.requestKey,
              code: input.code ?? '',
            }),
          )
        }
      />,
    )
  }
  if (account.state !== 'closed' && canAct(admin, 'mail.cap_override')) {
    actions.push(<CapsAction key="caps" account={account} />)
  }

  if (actions.length === 0) return null
  return <div className="flex flex-wrap gap-2">{actions}</div>
}
