import { type Contact, contactSchema } from '@dr/shared'
import { z } from 'zod'

/**
 * The registrant, as people type it, turned into the supplier's ContactInfo
 * shape (PRD FR-A4). The registry publishes and validates this, so a typo
 * here is a registration that fails after payment — validate before.
 */

/**
 * The national number as people type it — "0803 123 4567", "803-123-4567",
 * or pasted whole as "+234 803 123 4567" — reduced to what the supplier wants
 * beside the dialling code: digits only, no trunk 0 (E.164).
 */
export function nationalNumber(raw: string, countryCode: string): string {
  let digits = raw.replace(/\D/g, '')
  if (raw.trim().startsWith('+') && digits.startsWith(countryCode)) {
    digits = digits.slice(countryCode.length)
  } else if (digits.startsWith(`00${countryCode}`)) {
    digits = digits.slice(countryCode.length + 2)
  }
  return digits.replace(/^0+/, '')
}

const optional = z
  .string()
  .trim()
  .max(128)
  .transform((value) => value || undefined)
  .optional()

/** The checkout form, as submitted. */
export const registrantFormSchema = z.object({
  firstName: z.string().trim().min(1, 'Enter a first name').max(64),
  lastName: z.string().trim().min(1, 'Enter a last name').max(64),
  company: optional,
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email({ error: 'Enter a valid email address' })),
  phoneCountryCode: z
    .string()
    .trim()
    .transform((value) => value.replace(/\D/g, ''))
    .pipe(z.string().regex(/^\d{1,4}$/, 'Enter a dialling code, for example 234')),
  phone: z
    .string()
    .trim()
    .refine((value) => value.replace(/\D/g, '').length >= 7, 'Enter a phone number'),
  addressLine1: z.string().trim().min(1, 'Enter a street address').max(128),
  addressLine2: optional,
  city: z.string().trim().min(1, 'Enter a city').max(64),
  state: z.string().trim().min(1, 'Enter a state').max(64),
  zipCode: z.string().trim().min(1, 'Enter a postcode').max(16),
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'Choose a country'),
})
export type RegistrantForm = z.input<typeof registrantFormSchema>

/**
 * The registrant fields as a submitted form holds them (RegistrantFields).
 * `prefix` reads one of several contacts in the same form (FR-A4), as
 * RegistrantFields' `namePrefix` writes them.
 */
export function registrantFromForm(form: FormData, prefix = ''): RegistrantForm {
  const value = (name: keyof RegistrantForm) => String(form.get(`${prefix}${name}`) ?? '')
  return {
    firstName: value('firstName'),
    lastName: value('lastName'),
    company: value('company'),
    email: value('email'),
    phoneCountryCode: value('phoneCountryCode'),
    phone: value('phone'),
    addressLine1: value('addressLine1'),
    addressLine2: value('addressLine2'),
    city: value('city'),
    state: value('state'),
    zipCode: value('zipCode'),
    country: value('country'),
  }
}

export function toContact(form: z.output<typeof registrantFormSchema>): Contact {
  return contactSchema.parse({ ...form, phone: nationalNumber(form.phone, form.phoneCountryCode) })
}
