'use client'

import { useAction } from 'next-safe-action/hooks'
import { useId, useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { setAutoRenew } from '../actions/domains'

export function AutoRenewToggle({
  domainId,
  autoRenew,
  renewal,
}: {
  domainId: string
  autoRenew: boolean
  renewal: string | null
}) {
  const id = useId()
  const [checked, setChecked] = useState(autoRenew)
  const toggle = useAction(setAutoRenew, {
    // Shown straight away; put back if it did not save.
    onSuccess: ({ data, input }) => {
      if (data && 'error' in data) setChecked(!input.autoRenew)
    },
    onError: ({ input }) => setChecked(!input.autoRenew),
  })
  const failed =
    (toggle.result.data && 'error' in toggle.result.data ? toggle.result.data.error : null) ??
    toggle.result.serverError ??
    null

  return (
    <div>
      <label htmlFor={id} className="flex cursor-pointer items-start gap-3">
        <Switch
          id={id}
          checked={checked}
          disabled={toggle.isPending}
          onCheckedChange={(value) => {
            setChecked(value)
            toggle.execute({ domainId, autoRenew: value })
          }}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-note`}
          className="mt-0.5"
        />
        <span className="text-sm">
          <span id={`${id}-label`} className="font-medium text-foreground">
            Renew automatically
          </span>
          <span id={`${id}-note`} className="block text-pretty text-muted-foreground">
            {renewal ? `At ${renewal}/yr, 30 days before it expires. ` : ''}
            Renewals are not switched on yet — this records what you want to happen.
          </span>
        </span>
      </label>
      {failed ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {failed}
        </p>
      ) : null}
    </div>
  )
}
