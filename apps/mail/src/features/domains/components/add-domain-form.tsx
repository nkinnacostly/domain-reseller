'use client'

import { useRouter } from 'next/navigation'
import { useAction } from 'next-safe-action/hooks'
import { useId } from 'react'
import {
  describedBy,
  Field,
  FormMessage,
  fieldError,
  inputClass,
  onSubmitWith,
  SubmitButton,
} from '@/components/common/form-parts'
import { addDomain } from '../actions/domains'

/**
 * Adds a domain (MAIL-SPEC §5): the name only — `acme.ng`, or a subdomain
 * such as `mail.acme.ng`. SQL decides who owns it; the domain's page opens
 * with its DNS records once SES has given them.
 */
export function AddDomainForm({ accountId }: { accountId: string }) {
  const id = useId()
  const router = useRouter()
  const add = useAction(addDomain, {
    onSuccess: ({ data }) => {
      if (data && 'domainId' in data) router.push(`/dashboard/domains/${data.domainId}`)
    },
  })
  const data = add.result.data
  const error = (data && 'error' in data ? data.error : null) ?? add.result.serverError ?? null
  const nameError = fieldError(add.result.validationErrors, 'name')
  const hint = 'The domain only, such as acme.ng, or a subdomain such as mail.acme.ng.'

  return (
    <form
      aria-label="Add a domain"
      className="space-y-3"
      noValidate
      onSubmit={onSubmitWith((form) =>
        add.execute({ accountId, name: String(form.get('name') ?? '') }),
      )}
    >
      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
      <Field id={`${id}-name`} label="Domain" error={nameError} hint={hint}>
        <input
          id={`${id}-name`}
          name="name"
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="acme.ng"
          required
          aria-invalid={nameError ? true : undefined}
          aria-describedby={describedBy(`${id}-name`, nameError, hint)}
          className={inputClass}
        />
      </Field>
      <SubmitButton pending={add.isPending} pendingLabel="Adding…" className="sm:w-auto">
        Add domain
      </SubmitButton>
    </form>
  )
}
