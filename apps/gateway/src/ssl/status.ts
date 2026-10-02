import type { SslContact } from '@dr/shared'
import type { SupplierSslContact } from './client'

/**
 * Supplier words → our certificate states (migration 39). Seen in the
 * sandbox on 2 Oct 2026: WaitingForInstall after the purchase,
 * WaitingForValidation after the set-up, Active once issued. The others are
 * the words a CA's lifecycle has; a word we do not know is null — kept,
 * alerted after a day, never guessed (FR-SSL-7).
 */
export type SslState = 'awaiting_setup' | 'awaiting_validation' | 'issued' | 'revoked' | 'cancelled'

export function sslState(word: string | null | undefined): SslState | null {
  const text = String(word ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, '')
  switch (text) {
    case 'waitingforinstall':
      return 'awaiting_setup'
    case 'waitingforvalidation':
      return 'awaiting_validation'
    case 'active':
    // Still the issued certificate, now past its date: the page shows the date.
    case 'expired':
      return 'issued'
    case 'revoked':
      return 'revoked'
    case 'cancelled':
    case 'canceled':
      return 'cancelled'
    default:
      return null
  }
}

/** Configured at the supplier: the set-up is in and the CA has the request. */
export function isConfiguredWord(word: string | null | undefined): boolean {
  const state = sslState(word)
  return state === 'awaiting_validation' || state === 'issued'
}

const cut = (value: string | undefined, max: number) => (value ?? '').trim().slice(0, max)

/**
 * Our contact → the supplier's ConfigureContactInput. Its limits are odd —
 * a two-character phone country code, 15 for the phone, 20 for city and
 * state — so (sandbox, 2 Oct 2026):
 * - the phone travels whole, with its dialling code: "+2348031234567". A
 *   Nigerian code (234) does not fit the code field, which takes the
 *   two-letter country instead; the number itself loses nothing.
 * - fax is the phone: without one the set-up failed with an internal error.
 * - the company is the person's name when there is none.
 */
export function toSupplierContact(contact: SslContact): SupplierSslContact {
  const digits = `${contact.phoneCountryCode}${contact.phone}`.replace(/\D/g, '')
  const phone = (digits.length <= 14 ? `+${digits}` : digits).slice(0, 15)
  const name = `${contact.firstName} ${contact.lastName}`.trim()
  return {
    firstName: cut(contact.firstName, 70),
    lastName: cut(contact.lastName, 70),
    companyName: cut(contact.company || name, 150),
    eMail: cut(contact.email, 150),
    address: cut([contact.addressLine1, contact.addressLine2].filter(Boolean).join(' '), 200),
    phoneCountryCode: contact.country,
    phone,
    faxCountryCode: contact.country,
    fax: phone,
    country: contact.country,
    city: cut(contact.city, 20),
    state: cut(contact.state, 20),
    postalCode: cut(contact.zipCode, 10),
  }
}
