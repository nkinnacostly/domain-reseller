'use client'

import { useAction } from 'next-safe-action/hooks'
import { useId } from 'react'
import { FormMessage, onSubmitWith, SubmitButton } from '@/components/common/form-parts'
import { updateProfile } from '../actions/accounts'
import type { AccountProfile } from '../lib/steps'
import { ProfileFields, profileFromForm } from './profile-fields'

/** The account's profile (MAIL-SPEC §10 Settings), for its owner and admins. */
export function ProfileForm({
  accountId,
  profile,
}: {
  accountId: string
  profile: AccountProfile
}) {
  const id = useId()
  const save = useAction(updateProfile)
  const data = save.result.data

  return (
    <form
      aria-label="Account profile"
      className="max-w-xl space-y-4"
      noValidate
      onSubmit={onSubmitWith((form) => save.execute({ accountId, ...profileFromForm(form) }))}
    >
      {data && 'ok' in data ? (
        <FormMessage tone="success">
          {data.changed > 0 ? 'Saved.' : 'Nothing had changed, so nothing was saved.'}
        </FormMessage>
      ) : null}
      {data && 'error' in data ? <FormMessage tone="error">{data.error}</FormMessage> : null}
      {save.result.serverError ? (
        <FormMessage tone="error">{save.result.serverError}</FormMessage>
      ) : null}
      <ProfileFields id={id} errors={save.result.validationErrors} defaults={profile} />
      <SubmitButton pending={save.isPending} pendingLabel="Saving…" className="sm:w-auto">
        Save profile
      </SubmitButton>
    </form>
  )
}
