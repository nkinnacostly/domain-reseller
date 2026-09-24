'use client'

import { useEffect, useRef, useState } from 'react'
import { errorAt } from '../lib/errors'
import type { ProfileOption } from '../lib/profiles'
import { CONTACT_ROLES, type ContactRole, rolePrefix } from '../lib/roles'
import { RoleChoiceFields } from './role-choice-fields'

/**
 * FR-C5, FR-A4 — checkout's administrative, technical and billing contacts.
 * Collapsed by default: most people are all four themselves, and every role
 * starts as the registrant. The choice applies to every domain in the order.
 */
export function ContactRoles({
  profiles,
  errors,
  failure,
}: {
  profiles: ProfileOption[]
  /** The order's validation errors; this section reads `contacts`. */
  errors?: unknown
  /** The order's refusal; one naming a role (`contacts.billing`) is shown there. */
  failure?: { error: string; field?: string | undefined } | null | undefined
}) {
  const details = useRef<HTMLDetailsElement>(null)
  /**
   * The choices are built the first time the section opens, and kept when it
   * closes again — a closed section still sends what was chosen in it.
   */
  const [shown, setShown] = useState(false)
  const refused = failure?.field?.startsWith('contacts.')
    ? (failure.field.split('.')[1] as ContactRole)
    : null
  const invalid =
    Boolean((errors as { contacts?: unknown } | undefined)?.contacts) || refused !== null

  // A problem inside a closed section would go unseen: open it.
  useEffect(() => {
    if (invalid && details.current) details.current.open = true
  }, [invalid])

  return (
    <details
      ref={details}
      onToggle={(event) => {
        if (event.currentTarget.open) setShown(true)
      }}
      className="group mt-6 rounded-2xl border border-border bg-background/80 p-5"
    >
      <summary className="cursor-pointer list-none font-medium text-foreground marker:hidden">
        Different contacts for administrative, technical or billing?{' '}
        <span className="font-normal text-muted-foreground">Optional</span>
      </summary>
      <p className="mt-2 text-pretty text-sm/6 text-muted-foreground">
        Unless you choose someone else, the registrant is also the administrative, technical and
        billing contact. One choice for every domain in this order — change them later from each
        domain’s Contacts tab.
      </p>

      {shown || invalid ? (
        <div className="mt-5 space-y-8">
          {CONTACT_ROLES.map((role) => (
            <RoleChoiceFields
              key={role}
              contactRole={role}
              namePrefix={rolePrefix(role)}
              profiles={profiles}
              fieldError={(name) => errorAt(errors, ['contacts', role, 'contact', name])}
              profileError={errorAt(errors, ['contacts', role, 'profileId'])}
              problem={refused === role ? failure?.error : undefined}
            />
          ))}
        </div>
      ) : null}
    </details>
  )
}
