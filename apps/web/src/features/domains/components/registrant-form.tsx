'use client'

import { TriangleAlert } from 'lucide-react'
import { useAction } from 'next-safe-action/hooks'
import { useId, useState } from 'react'
import { FormMessage, onSubmitWith, SubmitButton } from '@/components/common/form-parts'
import { RegistrantFields, registrantFrom } from '@/features/checkout/components/registrant-fields'
import type { RegistrantForm as RegistrantValues } from '@/features/checkout/lib/contact'
import { changeRegistrant } from '../actions/settings'
import { isMaterialChange } from '../lib/settings'
import { ActionError, useOutcome } from './settings-parts'

/** next-safe-action's formatted errors for one registrant field. */
function registrantError(errors: unknown, field: string): string | undefined {
  const node = (errors as { registrant?: Record<string, { _errors?: string[] }> } | undefined)
    ?.registrant?.[field]
  return node?._errors?.[0]
}

/**
 * FR-DS1, FR-DS2: edit the registrant with the fields checkout asks for.
 * The same person stays in every role, as at checkout. On a generic
 * extension a new name, organisation or email is an ICANN change of
 * registrant, which can stop transfers for 60 days — so it is saved only
 * after the customer ticks that they accept it (PRD §7.3). Needs a fresh
 * second factor (SEC-2).
 */
export function RegistrantForm({
  domainId,
  domain,
  current,
  requested,
  generic,
}: {
  domainId: string
  domain: string
  /** What the registry holds. */
  current: RegistrantValues | null
  /** Asked for and not yet confirmed, or null. The form starts from it if there is one. */
  requested: RegistrantValues | null
  /** A generic extension, where ICANN's change-of-registrant rule applies. */
  generic: boolean
}) {
  const id = useId()
  const [material, setMaterial] = useState(false)
  const outcome = useOutcome()
  const save = useAction(changeRegistrant, outcome.callbacks)
  const errors = save.result.validationErrors
  const data = save.result.data
  const lockError = data && 'field' in data && data.field === 'acceptTransferLock'

  const start = requested ?? current ?? { country: 'NG' }

  return (
    <form
      aria-label="Change the registrant"
      noValidate
      className="space-y-6"
      onChange={(event) => {
        if (!generic) return
        setMaterial(isMaterialChange(current, registrantFrom(new FormData(event.currentTarget))))
      }}
      onSubmit={onSubmitWith((form) =>
        save.execute({
          domainId,
          registrant: registrantFrom(form),
          acceptTransferLock: form.get('acceptTransferLock') === 'on',
        }),
      )}
    >
      <RegistrantFields
        idPrefix={id}
        registrant={start}
        errorFor={(name) => registrantError(errors, name)}
      />

      {generic && material ? (
        <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-4">
          <p className="flex items-start gap-2.5 text-sm/6 font-medium text-foreground">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
            This is a change of registrant
          </p>
          <p className="mt-1.5 text-pretty text-sm/6 text-muted-foreground">
            A new name, organisation or email address changes who legally holds the domain. Under
            ICANN’s Transfer Policy the registrar can then refuse to move it to another registrar
            for 60 days. ICANN lets registrars offer an opt-out before the change; we don’t offer
            one.
          </p>
          <label className="mt-3 flex cursor-pointer items-start gap-3 text-sm/6">
            <input
              type="checkbox"
              name="acceptTransferLock"
              aria-invalid={lockError ? true : undefined}
              className="mt-1 size-4 shrink-0 accent-[var(--accent)]"
            />
            <span className="text-foreground">
              I understand this domain may not move to another registrar for 60 days.
            </span>
          </label>
        </div>
      ) : null}

      <ActionError message={outcome.error} returnTo={`/app/domains/${domain}/contacts`} />
      {outcome.sent ? (
        <FormMessage tone="success">
          Saved and sent to the registry. This page shows the new details once the registry confirms
          them.
        </FormMessage>
      ) : null}
      {errors ? (
        <FormMessage tone="error">Some details need fixing — they’re marked above.</FormMessage>
      ) : null}

      <SubmitButton pending={save.isPending} pendingLabel="Saving…" className="sm:w-auto">
        Save registrant
      </SubmitButton>
    </form>
  )
}
