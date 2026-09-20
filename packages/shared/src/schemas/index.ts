import { z } from 'zod'

/**
 * Validation schemas shared by the web app, the gateway and the tests.
 * Field shapes mirror the supplier's ContactInfo contract — PRD Appendix B.
 */

export const countryCode = z
  .string()
  .length(2, 'Use a two-letter country code')
  .regex(/^[A-Z]{2}$/, 'Country code must be uppercase ISO-3166-1 alpha-2')

export const contactSchema = z.object({
  firstName: z.string().min(1, 'First name is required').max(64),
  lastName: z.string().min(1, 'Last name is required').max(64),
  company: z.string().max(128).optional(),
  email: z.email('Enter a valid email address'),
  phoneCountryCode: z.string().regex(/^\d{1,4}$/, 'Country dialling code, digits only'),
  phone: z.string().regex(/^\d{4,15}$/, 'Phone number, digits only'),
  addressLine1: z.string().min(1, 'Address is required').max(128),
  addressLine2: z.string().max(128).optional(),
  addressLine3: z.string().max(128).optional(),
  city: z.string().min(1, 'City is required').max(64),
  state: z.string().min(1, 'State is required').max(64),
  zipCode: z.string().min(1, 'Postal code is required').max(16),
  country: countryCode,
})
export type Contact = z.infer<typeof contactSchema>

/** A single DNS label: 1–63 chars, alphanumeric and hyphens, no leading/trailing hyphen. */
const DNS_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

export const domainNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(253)
  .refine((value) => value.includes('.'), 'Include an extension, for example .com')
  .refine(
    (value) => value.split('.').every((label) => DNS_LABEL.test(label)),
    'Use only letters, numbers and hyphens',
  )

/** The searchable part, before any extension. */
export const domainStemSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Type at least one character')
  .max(63)
  .regex(DNS_LABEL, 'Use only letters, numbers and hyphens')

export const nameserverSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(253)
  .refine((value) => value.includes('.'), 'Enter a full hostname, for example ns1.example.com')
  .refine(
    (value) => value.split('.').every((label) => DNS_LABEL.test(label)),
    'That does not look like a valid nameserver hostname',
  )

/** Registries accept between 2 and 13 nameservers. Duplicates are rejected. */
export const nameserverSetSchema = z
  .array(nameserverSchema)
  .min(2, 'At least two nameservers are required')
  .max(13, 'No more than 13 nameservers')
  .refine((list) => new Set(list).size === list.length, 'Remove the duplicate nameserver')

export const searchQuerySchema = z.object({
  query: domainStemSchema,
  tlds: z.array(z.string().min(2).max(24)).max(50).optional(),
  periodYears: z.number().int().min(1).max(10).default(1),
})

export const cartItemSchema = z.object({
  domainName: domainNameSchema,
  periodYears: z.number().int().min(1).max(10),
  privacyRequested: z.boolean().default(false),
  autoRenewRequested: z.boolean().default(true),
  priceVersionId: z.uuid(),
})

export const checkoutSchema = z.object({
  items: z.array(cartItemSchema).min(1, 'Your cart is empty'),
  contactProfileId: z.uuid(),
  /** FR-C10 — optional nameservers supplied at checkout. */
  nameservers: nameserverSetSchema.optional(),
  nameserverPresetId: z.uuid().optional(),
  acknowledgedIrreversible: z
    .boolean()
    .refine((v) => v === true, 'Please confirm the spelling before continuing'),
})

export const transferInSchema = z.object({
  domainName: domainNameSchema,
  authCode: z.string().min(1, 'Enter the authorisation code from your current registrar').max(128),
  contactProfileId: z.uuid(),
})
