'use client'

import { EyeOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { QUIET_BUTTON } from '@/components/common/action-parts'
import {
  type RevealedContact,
  type RevealedRegistrant,
  revealRegistrant,
} from '@/features/admin/actions/domains'
import { ConfirmAction } from '@/features/admin/components/confirm-action'
import { DlGrid } from '@/features/admin/components/dl-grid'
import { CONTACT_ROLE_LABEL, countryWords, REVEAL } from '@/features/admin/lib/domains-copy'
import { adminOutcome } from '@/features/admin/lib/errors'

/**
 * The registrant (§5.2 B9, D4): its country and type from the masked view,
 * always; the rest only after "Show registrant", which calls the audited,
 * rate-limited `admin_reveal_registrant`. The details live in this
 * component's state and nowhere else, and are forgotten as soon as the page
 * is left — Next keeps a page you have left in the router's cache, state and
 * all, so the effect's cleanup clears them.
 */

const joined = (...parts: (string | undefined)[]) =>
  parts.filter((part): part is string => Boolean(part?.trim())).join(' ')

function contactItems(contact: RevealedContact) {
  const phone = contact.phone
    ? joined(contact.phoneCountryCode ? `+${contact.phoneCountryCode}` : undefined, contact.phone)
    : ''
  const address = [
    contact.addressLine1,
    contact.addressLine2,
    contact.addressLine3,
    joined(contact.city, contact.state, contact.zipCode),
  ].filter((line): line is string => Boolean(line?.trim()))
  return [
    { label: 'Name', value: joined(contact.firstName, contact.lastName) || '—' },
    { label: 'Organisation', value: contact.company || '—' },
    {
      label: 'Email',
      value: contact.email ? <span className="break-all">{contact.email}</span> : '—',
    },
    { label: 'Phone', value: phone || '—' },
    {
      label: 'Address',
      value:
        address.length > 0 ? (
          <span className="block">
            {address.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </span>
        ) : (
          '—'
        ),
      wide: true,
    },
    { label: 'Country', value: countryWords(contact.country) },
  ]
}

function Revealed({ details, onHide }: { details: RevealedRegistrant; onHide: () => void }) {
  return (
    <div className="space-y-5" data-revealed="registrant">
      {details.registrant ? (
        <section aria-labelledby="registrant-full-heading" className="space-y-3">
          <h3 id="registrant-full-heading" className="text-sm font-medium text-foreground">
            Registrant
          </h3>
          <DlGrid items={contactItems(details.registrant)} />
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">{REVEAL.none}</p>
      )}
      {details.contacts.map(({ role, contact }) => (
        <section key={role} aria-labelledby={`registrant-${role}-heading`} className="space-y-3">
          <h3 id={`registrant-${role}-heading`} className="text-sm font-medium text-foreground">
            {CONTACT_ROLE_LABEL[role] ?? role}
          </h3>
          <DlGrid items={contactItems(contact)} />
        </section>
      ))}
      {details.contacts.length === 0 && details.registrant ? (
        <p className="text-sm text-muted-foreground">
          The administrative, technical and billing contacts are the registrant.
        </p>
      ) : null}
      <button type="button" onClick={onHide} className={QUIET_BUTTON}>
        <EyeOff className="size-4" aria-hidden="true" />
        {REVEAL.hide}
      </button>
    </div>
  )
}

export function RegistrantPanel({
  domainId,
  name,
  country,
  type,
  hasRegistrant,
  canReveal,
  returnTo,
}: {
  domainId: string
  name: string
  /** Already in words: the summary the masked view gives. */
  country: string
  type: string
  hasRegistrant: boolean
  canReveal: boolean
  returnTo: string
}) {
  const [details, setDetails] = useState<RevealedRegistrant | null>(null)

  // Leaving the page keeps it hidden in the router's cache: forget the details then.
  useEffect(() => () => setDetails(null), [])

  return (
    <div className="space-y-5">
      <DlGrid
        items={[
          { label: 'Country', value: country },
          { label: 'Type', value: type },
        ]}
      />
      {!hasRegistrant ? (
        <p className="text-sm text-muted-foreground">{REVEAL.none}</p>
      ) : (
        <div className="space-y-4">
          {details ? (
            <Revealed details={details} onHide={() => setDetails(null)} />
          ) : (
            <p className="max-w-2xl text-sm/6 text-muted-foreground">{REVEAL.hidden}</p>
          )}
          {/* Kept mounted after a reveal, so its dialog can say so and hand focus back. */}
          {canReveal ? (
            <ConfirmAction
              trigger={REVEAL.trigger}
              title={REVEAL.title(name)}
              body={REVEAL.body}
              confirmLabel={REVEAL.confirm}
              reason="optional"
              returnTo={returnTo}
              successMessage={REVEAL.done}
              run={async (extra) => {
                const result = adminOutcome<RevealedRegistrant>(
                  await revealRegistrant({
                    domainId,
                    reason: extra.reason,
                    requestKey: extra.requestKey,
                  }),
                )
                if (result.ok && result.data) setDetails(result.data)
                return result
              }}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{REVEAL.roleOnly}</p>
          )}
        </div>
      )}
    </div>
  )
}
