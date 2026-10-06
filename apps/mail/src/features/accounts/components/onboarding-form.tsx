'use client'

import { useAction } from 'next-safe-action/hooks'
import { useId } from 'react'
import {
  describedBy,
  FormMessage,
  fieldError,
  onSubmitWith,
  SubmitButton,
} from '@/components/common/form-parts'
import { createAccount } from '../actions/accounts'
import { ProfileFields, profileFromForm } from './profile-fields'

/**
 * A new Mail account (MAIL-SPEC §7.1): what §7.1 asks for — name, website,
 * what it will send, expected volume — and the Acceptable Use Policy's first
 * rule, confirmed: transactional email only in v1 (M1). `create_account`
 * makes it, in the sandbox (§7.2), with the person as its owner.
 */
export function OnboardingForm() {
  const id = useId()
  const create = useAction(createAccount, {
    onSuccess: ({ data }) => {
      // A fresh load: the router's dashboard from before this account was made is stale.
      if (data && 'ok' in data) window.location.assign('/dashboard?welcome=1')
    },
  })
  const errors = create.result.validationErrors
  const confirmError = fieldError(errors, 'transactionalOnly')

  return (
    <form
      aria-label="Create a Mail account"
      className="space-y-4"
      noValidate
      onSubmit={onSubmitWith((form) =>
        create.execute({
          ...profileFromForm(form),
          transactionalOnly: (form.get('transactionalOnly') === 'on') as true,
        }),
      )}
    >
      {create.result.data && 'error' in create.result.data ? (
        <FormMessage tone="error">{create.result.data.error}</FormMessage>
      ) : null}
      {create.result.serverError ? (
        <FormMessage tone="error">{create.result.serverError}</FormMessage>
      ) : null}

      <ProfileFields id={id} errors={errors} />

      <div>
        <div className="flex items-start gap-3 rounded-2xl border border-border bg-background p-4">
          <input
            id={`${id}-aup`}
            name="transactionalOnly"
            type="checkbox"
            required
            aria-invalid={confirmError ? true : undefined}
            aria-describedby={describedBy(`${id}-aup`, confirmError, 'aup')}
            className="mt-0.5 size-5 shrink-0 accent-primary"
          />
          <div>
            <label htmlFor={`${id}-aup`} className="text-sm font-medium">
              I will send transactional email only
            </label>
            <p id={`${id}-aup-hint`} className="mt-1 text-pretty text-xs/5 text-muted-foreground">
              Receipts, sign-in links, alerts: email a person expects because of something they did.
              No newsletters or marketing, and no bought, rented or scraped lists. Mail does not
              offer bulk or marketing email.
            </p>
          </div>
        </div>
        {confirmError ? (
          <p id={`${id}-aup-error`} className="mt-1.5 text-sm text-tone-danger-foreground">
            {confirmError}
          </p>
        ) : null}
      </div>

      <SubmitButton
        pending={create.isPending || Boolean(create.result.data && 'ok' in create.result.data)}
        pendingLabel="Creating the account…"
      >
        Create the account
      </SubmitButton>
    </form>
  )
}
