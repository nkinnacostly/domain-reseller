import { type Contact, contactSchema } from '@dr/shared'

/**
 * A domain's four contacts (FR-A4, FR-DS1). The registrant is stored on its
 * own (`registrant`); the administrative, technical and billing contacts live
 * in `contacts` (migration 29), each a Contact. A role left out is held by the
 * registrant — which is what every domain registered before migration 29 has.
 */

export const OTHER_ROLES = ['administrative', 'technical', 'billing'] as const
export type OtherRole = (typeof OTHER_ROLES)[number]

/** `orders.contacts`, `domains.contacts` and `domains.pending_contacts`. */
export type OtherContacts = Partial<Record<OtherRole, Contact>>

/** Every role filled in: what is sent to the registry. */
export type ContactRoles = Record<'registrant' | OtherRole, Contact>

/**
 * The other three roles as stored. Null or absent — the column, or one role
 * in it — is the registrant. Null back when a role holds something that is
 * not a valid contact: our data, for a person to fix, never sent.
 */
export function parseOtherContacts(value: unknown): OtherContacts | null {
  if (value === null || value === undefined) return {}
  if (typeof value !== 'object' || Array.isArray(value)) return null
  const stored = value as Record<string, unknown>
  const contacts: OtherContacts = {}
  for (const role of OTHER_ROLES) {
    const held = stored[role]
    if (held === null || held === undefined) continue
    const parsed = contactSchema.safeParse(held)
    if (!parsed.success) return null
    contacts[role] = parsed.data
  }
  return contacts
}

/** Each other role from `others`, or else the registrant. */
export function contactRoles(registrant: Contact, others: OtherContacts = {}): ContactRoles {
  return {
    registrant,
    administrative: others.administrative ?? registrant,
    technical: others.technical ?? registrant,
    billing: others.billing ?? registrant,
  }
}
