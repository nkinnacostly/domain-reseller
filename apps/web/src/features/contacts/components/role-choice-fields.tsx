'use client'

import { useId, useState } from 'react'
import { describedBy, Field, inputClass } from '@/components/common/form-parts'
import { RegistrantFields } from '@/features/checkout/components/registrant-fields'
import type { RegistrantForm } from '@/features/checkout/lib/contact'
import type { ProfileOption } from '../lib/profiles'
import { type ContactRole, ROLE_LABEL, ROLE_PURPOSE, type RoleStart } from '../lib/roles'

const OPTION =
  'relative flex items-start gap-3 rounded-xl border border-border bg-background p-4 text-sm/6 transition-colors hover:bg-muted/60 has-[:checked]:border-ring has-[:checked]:bg-brand-subtle'
/** Above the label's cover, so the radio itself still takes a click. */
const RADIO =
  'relative z-10 mt-1 size-4 shrink-0 accent-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
/** The label covers the whole card, so a tap anywhere on it picks the option (S7). */
const OPTION_LABEL = 'cursor-pointer font-medium text-foreground after:absolute after:inset-0'

/**
 * One role's contact (FR-A4, FR-DS1): the registrant, a saved profile, or
 * new details with the registrant's own fields and checks. Uncontrolled
 * fields, read with `roleChoiceFromForm(form, namePrefix)`. New details are
 * rendered only once chosen, so a form without them holds one set of
 * contact fields.
 */
export function RoleChoiceFields({
  contactRole: role,
  namePrefix = '',
  profiles,
  start = { kind: 'registrant' },
  fieldError = () => undefined,
  profileError,
  problem,
  onChange,
}: {
  contactRole: ContactRole
  /** Prepended to every field's name when one form holds several roles. */
  namePrefix?: string
  profiles: ProfileOption[]
  start?: RoleStart
  /** A new-details field's validation message. */
  fieldError?: (name: keyof RegistrantForm) => string | undefined
  profileError?: string | undefined
  /** Why the server refused this role, shown under its choices. */
  problem?: string | undefined
  onChange?: () => void
}) {
  const id = useId()
  // No saved profiles (deleted since): offer what can still be chosen.
  const initial = start.kind === 'profile' && profiles.length === 0 ? 'registrant' : start.kind
  const [kind, setKind] = useState<RoleStart['kind']>(initial)
  const [profileId, setProfileId] = useState(start.kind === 'profile' ? start.profileId : '')
  const label = `${ROLE_LABEL[role]} contact`

  const option = (value: RoleStart['kind'], text: string, hint: string) => (
    <div className={OPTION}>
      <input
        id={`${id}-choice-${value}`}
        type="radio"
        name={`${namePrefix}choice`}
        value={value}
        checked={kind === value}
        onChange={() => {
          setKind(value)
          onChange?.()
        }}
        aria-describedby={`${id}-choice-${value}-hint`}
        className={RADIO}
      />
      <div className="min-w-0">
        <label htmlFor={`${id}-choice-${value}`} className={OPTION_LABEL}>
          {text}
        </label>
        <p id={`${id}-choice-${value}-hint`} className="text-pretty text-muted-foreground">
          {hint}
        </p>
      </div>
    </div>
  )

  return (
    <fieldset
      className="min-w-0 space-y-3"
      aria-describedby={problem ? `${id}-purpose ${id}-problem` : `${id}-purpose`}
    >
      <legend className="font-medium text-foreground">{label}</legend>
      <p id={`${id}-purpose`} className="-mt-1 text-pretty text-sm/6 text-muted-foreground">
        {ROLE_PURPOSE[role]}
      </p>

      {option(
        'registrant',
        'Same as the registrant',
        'Follows the registrant’s details, including any later change.',
      )}
      {profiles.length > 0
        ? option('profile', 'A saved contact', 'One of the contacts saved in your account.')
        : null}
      {kind === 'profile' ? (
        <div className="pl-7">
          <Field id={`${id}-profile`} label="Saved contact" error={profileError}>
            <select
              id={`${id}-profile`}
              name={`${namePrefix}profileId`}
              value={profileId}
              onChange={(event) => {
                setProfileId(event.target.value)
                onChange?.()
              }}
              aria-invalid={profileError ? true : undefined}
              aria-describedby={describedBy(`${id}-profile`, profileError)}
              className={inputClass}
            >
              <option value="">Choose a saved contact</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name && profile.name !== profile.label
                    ? `${profile.label} — ${profile.name}`
                    : profile.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      ) : null}
      {option('new', 'New details', 'Someone else, or the same person at another address.')}
      {kind === 'new' ? (
        <div className="rounded-xl border border-border p-4">
          <RegistrantFields
            idPrefix={`${id}-new`}
            namePrefix={namePrefix}
            registrant={
              start.kind === 'new' ? start.values : { country: 'NG', phoneCountryCode: '234' }
            }
            errorFor={fieldError}
          />
        </div>
      ) : null}

      {problem ? (
        <p id={`${id}-problem`} className="text-pretty text-sm text-destructive">
          {problem}
        </p>
      ) : null}
    </fieldset>
  )
}
