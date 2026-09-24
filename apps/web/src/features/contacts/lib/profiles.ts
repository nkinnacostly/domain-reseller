import type { Contact } from '@dr/shared'
import { z } from 'zod'
import { type RegistrantForm, registrantFormSchema } from '@/features/checkout/lib/contact'

/**
 * Saved contact profiles (FR-A4): a named Contact in `contact_profiles`,
 * owned by the account under RLS (migration 01). The fields mirror the
 * supplier's ContactInfo shape, so a profile can stand in any of the four
 * roles.
 */

export const PROFILE_COLUMNS =
  'id, label, is_default, first_name, last_name, company, email, phone, phone_country_code, address_line1, address_line2, city, state, zip_code, country'

export type ProfileRow = {
  id: string
  label: string
  is_default: boolean
  first_name: string
  last_name: string
  company: string | null
  email: string
  phone: string
  phone_country_code: string
  address_line1: string
  address_line2: string | null
  city: string
  state: string
  zip_code: string
  country: string
}

export type ContactProfile = {
  id: string
  label: string
  isDefault: boolean
  /** As the contact fields show them. */
  values: RegistrantForm
}

/** A profile for a picker: its name and whose details it holds — no more (N13). */
export type ProfileOption = { id: string; label: string; name: string }

/** Enough profiles for every role of several businesses; more is a script. */
export const MAX_PROFILES = 25

export function profileFromRow(row: ProfileRow): ContactProfile {
  return {
    id: row.id,
    label: row.label,
    isDefault: row.is_default,
    values: {
      firstName: row.first_name,
      lastName: row.last_name,
      company: row.company ?? '',
      email: row.email,
      phoneCountryCode: row.phone_country_code,
      phone: row.phone,
      addressLine1: row.address_line1,
      addressLine2: row.address_line2 ?? '',
      city: row.city,
      state: row.state,
      zipCode: row.zip_code,
      country: row.country,
    },
  }
}

export function profileOption(profile: ContactProfile): ProfileOption {
  return {
    id: profile.id,
    label: profile.label,
    name: `${profile.values.firstName} ${profile.values.lastName}`.trim(),
  }
}

/** A validated Contact as the table's columns (E.164 national number already applied). */
export function rowFromContact(contact: Contact) {
  return {
    first_name: contact.firstName,
    last_name: contact.lastName,
    company: contact.company ?? null,
    email: contact.email,
    phone: contact.phone,
    phone_country_code: contact.phoneCountryCode,
    address_line1: contact.addressLine1,
    address_line2: contact.addressLine2 ?? null,
    city: contact.city,
    state: contact.state,
    zip_code: contact.zipCode,
    country: contact.country,
  }
}

/** The profile form, as submitted. */
export const profileFormSchema = z.object({
  id: z.uuid().optional(),
  label: z
    .string()
    .trim()
    .min(1, 'Give this contact a name')
    .max(64, 'Keep the name under 64 characters'),
  contact: registrantFormSchema,
  isDefault: z.boolean(),
})
export type ProfileFormInput = z.input<typeof profileFormSchema>
