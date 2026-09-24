'use client'

import { TriangleAlert } from 'lucide-react'
import { useAction } from 'next-safe-action/hooks'
import { useEffect, useId, useRef, useState } from 'react'
import { FormMessage } from '@/components/common/form-parts'
import { FOCUS } from '@/components/layout/panel'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { lockTransfers, unlockTransfers } from '../actions/settings'
import { pendingLabel } from '../lib/settings'
import { ActionError, NeedsTwoFactor, QUIET_BUTTON, SWITCH_ROW, useOutcome } from './settings-parts'

/**
 * FR-DS4: the transfer lock. Turning it on needs only a session; turning it
 * off is what a thief needs first, so it shows a warning and takes a fresh
 * second factor (SEC-2). The switch shows what was asked for; the line
 * beneath says whether the registry has confirmed it.
 */
export function TransferLockControl({
  domainId,
  domain,
  locked,
  pending,
  editable,
  hasTwoFactor,
}: {
  domainId: string
  domain: string
  /** What the registry holds. */
  locked: boolean
  /** What was asked for and not yet confirmed. Null: nothing waiting. */
  pending: boolean | null
  editable: boolean
  hasTwoFactor: boolean
}) {
  const id = useId()
  const [confirming, setConfirming] = useState(false)
  // Shown at once; the page's own answer takes over when the request settles.
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  const outcome = useOutcome()
  const handlers = { ...outcome.callbacks, onSettled: () => setOptimistic(null) }
  const lock = useAction(lockTransfers, handlers)
  const unlock = useAction(unlockTransfers, handlers)
  const busy = lock.isPending || unlock.isPending
  const requested = optimistic ?? pending ?? locked
  const needsTwoFactor = requested && !hasTwoFactor
  // The question appears below the switch: take focus to it, on the safe answer.
  const keep = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (confirming) keep.current?.focus()
  }, [confirming])

  const state =
    pendingLabel(pending) ??
    (locked
      ? 'On — nobody can move this domain to another registrar.'
      : 'Off — this domain can be moved to another registrar with its transfer code.')

  return (
    <div className="space-y-4">
      <label htmlFor={id} className={SWITCH_ROW}>
        <Switch
          id={id}
          checked={requested}
          disabled={!editable || busy || needsTwoFactor}
          onCheckedChange={(on) => {
            if (on) {
              setConfirming(false)
              setOptimistic(true)
              lock.execute({ domainId })
            } else {
              setConfirming(true)
            }
          }}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-state`}
          className="mt-0.5"
        />
        <span>
          <span id={`${id}-label`} className="font-medium text-foreground">
            Transfer lock
          </span>
          <span id={`${id}-state`} className="block text-pretty text-muted-foreground">
            {state}
          </span>
        </span>
      </label>

      {editable && needsTwoFactor ? (
        <NeedsTwoFactor>
          Turning the lock off lets the domain be moved away, so it needs two-factor authentication
          on your account.
        </NeedsTwoFactor>
      ) : null}

      {confirming ? (
        <fieldset className="rounded-2xl border border-destructive/40 bg-destructive/5 p-4">
          <legend className="sr-only">Turn off the transfer lock?</legend>
          <p
            aria-hidden="true"
            className="flex items-start gap-2.5 text-sm/6 font-medium text-foreground"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            Turn off the transfer lock?
          </p>
          <p className="mt-1.5 text-pretty text-sm/6 text-muted-foreground">
            With the lock off, anyone who has the transfer code can move this domain to another
            registrar. Turn it off only when you are ready to transfer, and turn it back on if you
            change your mind.
          </p>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirming(false)
                setOptimistic(false)
                unlock.execute({ domainId })
              }}
              className={cn(
                'inline-flex h-11 items-center justify-center rounded-full border border-destructive bg-background px-5 text-sm font-medium text-destructive transition hover:bg-destructive/10 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70',
                FOCUS,
              )}
            >
              Turn off transfer lock
            </button>
            <button
              ref={keep}
              type="button"
              onClick={() => setConfirming(false)}
              className={QUIET_BUTTON}
            >
              Keep it on
            </button>
          </div>
        </fieldset>
      ) : null}

      <ActionError message={outcome.error} returnTo={`/app/domains/${domain}/security`} />
      {outcome.sent && pending !== null ? (
        <FormMessage tone="success">
          Sent to the registry. This page shows the change once the registry confirms it.
        </FormMessage>
      ) : null}
    </div>
  )
}
