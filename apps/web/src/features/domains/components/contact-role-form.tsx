'use client'

import { useAction } from 'next-safe-action/hooks'
import { FormMessage, onSubmitWith, SubmitButton } from '@/components/common/form-parts'
import { RoleChoiceFields } from '@/features/contacts/components/role-choice-fields'
import { errorAt } from '@/features/contacts/lib/errors'
import type { ProfileOption } from '@/features/contacts/lib/profiles'
import {
  type ContactRole,
  ROLE_LABEL,
  type RoleStart,
  roleChoiceFromForm,
} from '@/features/contacts/lib/roles'
import { changeContactRole } from '../actions/settings'
import { ActionError, useOutcome } from './settings-parts'

/**
 * FR-DS1: change one of the other three contacts. Saved as a request and
 * sent to the registry with the registrant (migration 29); the page shows
 * it as done only once the registry confirms. Needs a fresh second factor
 * (SEC-2), like the registrant — but no 60-day warning, which is the
 * registrant's alone (FR-DS2).
 */
export function ContactRoleForm({
  domainId,
  domain,
  contactRole: role,
  profiles,
  start,
}: {
  domainId: string
  domain: string
  contactRole: ContactRole
  profiles: ProfileOption[]
  /** What the role holds, or will once a change waiting for the registry lands. */
  start: RoleStart
}) {
  const outcome = useOutcome()
  const save = useAction(changeContactRole, outcome.callbacks)
  const errors = save.result.validationErrors
  const name = ROLE_LABEL[role].toLowerCase()

  return (
    <form
      aria-label={`Change the ${name} contact`}
      noValidate
      className="space-y-5"
      onSubmit={onSubmitWith((form) =>
        save.execute({ domainId, role, choice: roleChoiceFromForm(form) }),
      )}
    >
      <RoleChoiceFields
        contactRole={role}
        profiles={profiles}
        start={start}
        fieldError={(field) => errorAt(errors, ['choice', 'contact', field])}
        profileError={errorAt(errors, ['choice', 'profileId'])}
      />

      <ActionError message={outcome.error} returnTo={`/app/domains/${domain}/contacts`} />
      {outcome.sent ? (
        <FormMessage tone="success">
          Saved and sent to the registry. This page shows the {name} contact as changed once the
          registry confirms it.
        </FormMessage>
      ) : null}
      {errors ? (
        <FormMessage tone="error">Some details need fixing — they’re marked above.</FormMessage>
      ) : null}

      <SubmitButton pending={save.isPending} pendingLabel="Saving…" className="sm:w-auto">
        Save {name} contact
      </SubmitButton>
    </form>
  )
}
