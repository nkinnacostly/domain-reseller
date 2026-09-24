import type { Contact } from '@dr/shared'
import { z } from 'zod'
import {
  type RegistrantForm,
  registrantFormSchema,
  registrantFromForm,
} from '@/features/checkout/lib/contact'
import { sameRegistrant } from '@/features/domains/lib/settings'
import type { ContactProfile } from './profiles'

/**
 * The other three contacts (FR-A4, FR-DS1): administrative, technical and
 * billing. Stored as `{"administrative": {...}, "technical": {...},
 * "billing": {...}}` on orders and domains, each a Contact like the
 * registrant; a role left out is held by the registrant (migration 29), which
 * is what every domain registered before it has.
 */

export const CONTACT_ROLES = ['administrative', 'technical', 'billing'] as const
export type ContactRole = (typeof CONTACT_ROLES)[number]

export const ROLE_LABEL: Record<ContactRole, string> = {
  administrative: 'Administrative',
  technical: 'Technical',
  billing: 'Billing',
}

/** What each role is for, in the registry's terms — nothing we do with it (N9b). */
export const ROLE_PURPOSE: Record<ContactRole, string> = {
  administrative: 'Who to contact about the domain and its registration.',
  technical: 'Who to contact about the domain’s technical setup, such as its nameservers.',
  billing: 'Who to contact about paying for the domain.',
}

/** A contact as stored: the Contact shape, read back from JSON. */
export type StoredContact = Record<string, string | undefined>
/** The roles held by someone other than the registrant. */
export type StoredRoles = Partial<Record<ContactRole, StoredContact>>

/**
 * One role's choice, as a form sends it: the registrant, a saved contact
 * profile — only its id travels, and the server reads it back under RLS —
 * or new details, validated like the registrant's.
 */
export const roleChoiceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('registrant') }),
  z.object({ kind: z.literal('profile'), profileId: z.uuid({ error: 'Choose a saved contact' }) }),
  z.object({ kind: z.literal('new'), contact: registrantFormSchema }),
])
export type RoleChoice = z.input<typeof roleChoiceSchema>
export type ParsedRoleChoice = z.output<typeof roleChoiceSchema>

/** Checkout's roles: any left out stay with the registrant. */
export const contactRolesInputSchema = z.object({
  administrative: roleChoiceSchema.optional(),
  technical: roleChoiceSchema.optional(),
  billing: roleChoiceSchema.optional(),
})
export type ContactRolesInput = z.input<typeof contactRolesInputSchema>

/** The field-name prefix one role's fields carry when a form holds all three. */
export const rolePrefix = (role: ContactRole) => `contacts.${role}.`

/** One role's choice as RoleChoiceFields wrote it into the form. */
export function roleChoiceFromForm(form: FormData, prefix = ''): RoleChoice {
  const kind = String(form.get(`${prefix}choice`) ?? 'registrant')
  if (kind === 'profile') {
    return { kind, profileId: String(form.get(`${prefix}profileId`) ?? '') }
  }
  if (kind === 'new') return { kind, contact: registrantFromForm(form, prefix) }
  return { kind: 'registrant' }
}

/**
 * Checkout's three roles from the form, or undefined when every role stays
 * with the registrant — so an order without other contacts is sent exactly
 * as before.
 */
export function contactRolesFromForm(form: FormData): ContactRolesInput | undefined {
  const roles: ContactRolesInput = {}
  for (const role of CONTACT_ROLES) {
    const choice = roleChoiceFromForm(form, rolePrefix(role))
    if (choice.kind !== 'registrant') roles[role] = choice
  }
  return Object.keys(roles).length > 0 ? roles : undefined
}

const isRecord = (value: unknown): value is StoredContact =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `domains.contacts` or `pending_contacts` as stored; anything else is no roles. */
export function readRoles(value: unknown): StoredRoles {
  if (!isRecord(value)) return {}
  const roles: StoredRoles = {}
  for (const role of CONTACT_ROLES) {
    const contact = (value as Record<string, unknown>)[role]
    if (isRecord(contact)) roles[role] = contact
  }
  return roles
}

/** Whether two contacts say the same thing, ignoring case and spacing. */
export function sameContact(a: StoredContact | undefined, b: StoredContact | undefined): boolean {
  if (!a || !b) return a === b
  return sameRegistrant(a, b as Contact)
}

/** Whether two sets of roles hold the same people in the same roles. */
export function sameRoles(a: StoredRoles, b: StoredRoles): boolean {
  return CONTACT_ROLES.every((role) => sameContact(a[role], b[role]))
}

/** One role set to a contact, or back to the registrant (null). */
export function withRole(
  roles: StoredRoles,
  role: ContactRole,
  contact: StoredContact | null,
): StoredRoles {
  const next = { ...roles }
  if (contact) next[role] = contact
  else delete next[role]
  return next
}

/**
 * A role whose contact is the registrant is the registrant's (migration 29):
 * left out, so it follows the registrant from then on.
 */
export function heldByOthers<T extends StoredContact>(
  roles: Partial<Record<ContactRole, T>>,
  registrant: StoredContact | null,
): Partial<Record<ContactRole, T>> {
  const others: Partial<Record<ContactRole, T>> = {}
  for (const role of CONTACT_ROLES) {
    const contact = roles[role]
    if (contact && !(registrant && sameContact(registrant, contact))) others[role] = contact
  }
  return others
}

/** The roles the registrant also holds, in words — or null when it holds none. */
export function registrantAlsoHolds(roles: StoredRoles): string | null {
  const held = CONTACT_ROLES.filter((role) => !roles[role]).map((role) =>
    ROLE_LABEL[role].toLowerCase(),
  )
  const last = held.pop()
  if (!last) return null
  return `Also the ${held.length > 0 ? `${held.join(', ')} and ${last}` : last} contact.`
}

/** Where a role's picker starts: the registrant, a saved profile, or the details themselves. */
export type RoleStart =
  | { kind: 'registrant' }
  | { kind: 'profile'; profileId: string }
  | { kind: 'new'; values: Partial<RegistrantForm> }

/**
 * A role's picker starts from what it holds: the registrant, the saved
 * profile with the same details, or those details to edit.
 */
export function roleStart(
  contact: StoredContact | undefined,
  profiles: ContactProfile[],
): RoleStart {
  if (!contact) return { kind: 'registrant' }
  const saved = profiles.find((profile) => sameContact(profile.values, contact))
  if (saved) return { kind: 'profile', profileId: saved.id }
  return { kind: 'new', values: contact as Partial<RegistrantForm> }
}
