'use client'

import { describedBy, Field, fieldError, inputClass } from '@/components/common/form-parts'
import { cn } from '@/lib/utils'
import type { AccountProfile } from '../lib/steps'

const HINTS = {
  name: 'Your business or project, as your team knows it.',
  website: 'Where people can see who you are and what you do.',
  useCase: 'For example: order receipts and password-reset emails for the customers of our shop.',
  volume: 'An estimate is fine. It does not set your caps; your plan does.',
}

/**
 * The account profile MAIL-SPEC §7.1 asks for at sign-up — name, website,
 * what it will send, expected monthly volume — shared by onboarding and
 * Settings. Uncontrolled: the forms read FormData on submit.
 */
export function ProfileFields({
  id,
  errors,
  defaults,
}: {
  id: string
  errors: unknown
  defaults?: AccountProfile
}) {
  const err = (field: string) => fieldError(errors, field)
  return (
    <>
      <Field id={`${id}-name`} label="Account name" error={err('name')} hint={HINTS.name}>
        <input
          id={`${id}-name`}
          name="name"
          autoComplete="organization"
          required
          maxLength={100}
          defaultValue={defaults?.name}
          aria-invalid={err('name') ? true : undefined}
          aria-describedby={describedBy(`${id}-name`, err('name'), HINTS.name)}
          className={inputClass}
        />
      </Field>
      <Field id={`${id}-website`} label="Website" error={err('website')} hint={HINTS.website}>
        <input
          id={`${id}-website`}
          name="website"
          type="text"
          inputMode="url"
          autoComplete="url"
          placeholder="https://acme.ng"
          required
          maxLength={200}
          defaultValue={defaults?.website ?? undefined}
          aria-invalid={err('website') ? true : undefined}
          aria-describedby={describedBy(`${id}-website`, err('website'), HINTS.website)}
          className={inputClass}
        />
      </Field>
      <Field
        id={`${id}-use`}
        label="What will you send?"
        error={err('useCase')}
        hint={HINTS.useCase}
      >
        <textarea
          id={`${id}-use`}
          name="useCase"
          required
          rows={3}
          maxLength={1000}
          defaultValue={defaults?.useCase ?? undefined}
          aria-invalid={err('useCase') ? true : undefined}
          aria-describedby={describedBy(`${id}-use`, err('useCase'), HINTS.useCase)}
          className={cn(inputClass, 'h-auto min-h-24 py-2.5')}
        />
      </Field>
      <Field
        id={`${id}-volume`}
        label="About how many emails a month?"
        error={err('expectedMonthlyVolume')}
        hint={HINTS.volume}
      >
        <input
          id={`${id}-volume`}
          name="expectedMonthlyVolume"
          inputMode="numeric"
          autoComplete="off"
          placeholder="5000"
          required
          maxLength={12}
          defaultValue={defaults?.expectedMonthlyVolume ?? undefined}
          aria-invalid={err('expectedMonthlyVolume') ? true : undefined}
          aria-describedby={describedBy(`${id}-volume`, err('expectedMonthlyVolume'), HINTS.volume)}
          className={cn(inputClass, 'max-w-48 tabular-nums')}
        />
      </Field>
    </>
  )
}

/** What the four fields hold, read from a submitted form. */
export function profileFromForm(form: FormData) {
  return {
    name: String(form.get('name') ?? ''),
    website: String(form.get('website') ?? ''),
    useCase: String(form.get('useCase') ?? ''),
    expectedMonthlyVolume: String(form.get('expectedMonthlyVolume') ?? ''),
  }
}
