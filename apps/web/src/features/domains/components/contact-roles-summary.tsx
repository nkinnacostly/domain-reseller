import {
  CONTACT_ROLES,
  type ContactRole,
  ROLE_LABEL,
  type StoredRoles,
  sameContact,
  sameRoles,
} from '@/features/contacts/lib/roles'
import { RegistrantSummary } from './registrant-summary'

/**
 * A contact change can wait on a person, not just the registry: the sandbox
 * has accepted contacts it then did not show, and the gateway hands such a
 * change to us rather than sending it again. So no time is promised.
 */
export const CONTACTS_WAIT_NOTE =
  'We’ve sent this to the registry. If it isn’t showing here within a day, we’ll look into it.'

/**
 * FR-DS1 — the administrative, technical and billing contacts as the
 * registry holds them, and any change waiting for it (migration 29). A role
 * left out is the registrant's, and says so in words.
 */
export function ContactRolesSummary({
  contacts,
  pending,
}: {
  contacts: StoredRoles
  /** Null: nothing waiting. Otherwise the whole set asked for. */
  pending: StoredRoles | null
}) {
  const waiting = pending !== null && !sameRoles(pending, contacts)
  return (
    <>
      <dl className="mt-4 space-y-5">
        {CONTACT_ROLES.map((role) => (
          <div key={role}>
            <dt className="font-medium text-foreground">{ROLE_LABEL[role]}</dt>
            <dd className="mt-1">
              <Holder contacts={contacts} role={role} className="text-muted-foreground" />
              {pending && !sameContact(pending[role], contacts[role]) ? (
                <div className="mt-2 rounded-xl bg-muted/60 px-4 py-3">
                  <p className="font-medium text-foreground">Waiting for the registry</p>
                  <p className="text-muted-foreground">
                    {pending[role]
                      ? 'Changing to these details once the registry confirms them:'
                      : 'Going back to the registrant once the registry confirms it.'}
                  </p>
                  {pending[role] ? (
                    <Holder contacts={pending} role={role} className="mt-2 text-foreground" />
                  ) : null}
                </div>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
      {waiting ? (
        <p className="mt-4 text-pretty text-muted-foreground">{CONTACTS_WAIT_NOTE}</p>
      ) : null}
    </>
  )
}

function Holder({
  contacts,
  role,
  className,
}: {
  contacts: StoredRoles
  role: ContactRole
  className?: string
}) {
  const contact = contacts[role]
  if (!contact) return <p className={className}>Same as the registrant</p>
  return <RegistrantSummary registrant={contact} className={className} />
}
