'use client'

import { useAction } from 'next-safe-action/hooks'
import { useId, useState } from 'react'
import { FormMessage } from '@/components/common/form-parts'
import { Switch } from '@/components/ui/switch'
import { setPrivacy } from '../actions/settings'
import { pendingLabel } from '../lib/settings'
import { ActionError, SWITCH_ROW, useOutcome } from './settings-parts'

/**
 * FR-DS3: contact privacy, offered where checkout offers it — generic
 * extensions. Where it is not, the control stays and says why rather than
 * disappearing.
 */
export function PrivacyControl({
  domainId,
  domain,
  tld,
  enabled,
  pending,
  editable,
  offered,
}: {
  domainId: string
  domain: string
  tld: string
  /** What the registry holds. */
  enabled: boolean
  pending: boolean | null
  editable: boolean
  offered: boolean
}) {
  const id = useId()
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  const outcome = useOutcome()
  const save = useAction(setPrivacy, {
    ...outcome.callbacks,
    onSettled: () => setOptimistic(null),
  })
  const requested = optimistic ?? pending ?? enabled

  const state = !offered
    ? `Not offered for .${tld} domains. Country-code registries set their own rules for what their public records show, so we offer privacy on generic extensions only.`
    : (pendingLabel(pending) ??
      (enabled
        ? 'On — your name, email and phone are kept out of public lookups.'
        : 'Off — your details can appear in public lookups (RDAP, formerly WHOIS).'))

  return (
    <div className="space-y-4">
      <label htmlFor={id} className={SWITCH_ROW}>
        <Switch
          id={id}
          checked={offered && requested}
          disabled={!offered || !editable || save.isPending}
          onCheckedChange={(on) => {
            setOptimistic(on)
            save.execute({ domainId, enabled: on })
          }}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-state`}
          className="mt-0.5"
        />
        <span>
          <span id={`${id}-label`} className="font-medium text-foreground">
            Contact privacy
          </span>
          <span id={`${id}-state`} className="block text-pretty text-muted-foreground">
            {state}
          </span>
        </span>
      </label>

      <ActionError message={outcome.error} returnTo={`/app/domains/${domain}/security`} />
      {outcome.sent && pending !== null ? (
        <FormMessage tone="success">
          Sent to the registry. This page shows the change once the registry confirms it.
        </FormMessage>
      ) : null}
    </div>
  )
}
