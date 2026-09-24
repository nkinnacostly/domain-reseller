import { type Contact, type LocalStatus, transferEligibleAt } from '@dr/shared'
import type { Note } from './registration'

/**
 * Registry-side settings (FR-DS1, FR-DS3, FR-DS4, FR-DS5): what the panel may
 * offer for a domain, and what it says while a change waits for the
 * registry. Copy describes what the system does (N9b): a change is saved as
 * a request, sent by the gateway, and shown as done only once the registry
 * confirms it (migration 26).
 */

type Subject = {
  status: LocalStatus
  source: 'registration' | 'transfer' | 'demo'
  testMode: boolean
}

/**
 * A two-letter last label is a country code: the same rule as the catalogue's
 * `tlds.is_country_code` (migration 03), which is what cart and checkout
 * offer privacy by.
 */
export function isCountryCodeTld(tld: string): boolean {
  return (tld.split('.').at(-1) ?? '').length === 2
}

/** FR-DS3: privacy is offered where checkout offers it — generic extensions. */
export function privacyOffered(tld: string): boolean {
  return !isCountryCodeTld(tld)
}

/** enqueue_domain_change queues only for these (migration 26). */
const CHANGEABLE: readonly LocalStatus[] = ['active', 'expired_grace']

export type Availability = { editable: true; note: Note | null } | { editable: false; note: Note }

export function settingsAvailability(domain: Subject): Availability {
  if (domain.source === 'demo') {
    return {
      editable: false,
      note: {
        title: 'Demo domain.',
        body: 'It is not registered anywhere, so nothing here reaches a registry and these settings cannot be changed.',
      },
    }
  }
  if (domain.status === 'pending') {
    return {
      editable: false,
      note: {
        title: 'Registering.',
        body: 'These settings can be changed once the registration completes.',
      },
    }
  }
  if (!CHANGEABLE.includes(domain.status)) {
    return {
      editable: false,
      note: {
        title: 'Not available.',
        body: 'These settings can be changed only while the domain is active.',
      },
    }
  }
  return {
    editable: true,
    note: domain.testMode
      ? {
          title: 'Sandbox domain.',
          body: 'Changes go to the registrar’s test system, not the live registry.',
        }
      : null,
  }
}

/** "Turning off — waiting for the registry", or nothing when no change is waiting. */
export function pendingLabel(requested: boolean | null): string | null {
  if (requested === null) return null
  return `Turning ${requested ? 'on' : 'off'} — waiting for the registry`
}

/**
 * The registry holds the domain for us in these states, so it has a
 * transfer code to give. Never conditioned on billing (N14, FR-T6).
 */
const HELD: readonly LocalStatus[] = [
  'active',
  'expired_grace',
  'redemption',
  'pending_verification',
]

export function transferCodeUnavailable(domain: Subject): string | null {
  if (domain.source === 'demo') {
    return 'This is a demo domain. It is not registered, so it has no transfer code.'
  }
  if (domain.status === 'pending') {
    return 'The transfer code is available once the registration completes.'
  }
  if (!HELD.includes(domain.status)) {
    return 'This domain is no longer held in your account, so there is no transfer code to give.'
  }
  return null
}

/**
 * FR-T7: registries may refuse a transfer for 60 days after registration or
 * a previous transfer. The latest of those dates decides; null once past.
 */
export function transferWindowEnds(dates: (string | null)[], now: Date): Date | null {
  const latest = dates
    .filter((date): date is string => Boolean(date))
    .map((date) => new Date(date))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => b.getTime() - a.getTime())[0]
  if (!latest) return null
  const ends = transferEligibleAt(latest)
  return ends > now ? ends : null
}

const squash = (value: string | undefined | null) =>
  (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

type Registrant = Partial<Record<keyof Contact, string | undefined>>

/**
 * A change of registrant under ICANN's Transfer Policy (PRD §7.3, FR-DS2): a
 * new name, organisation or email address. Only these start the 60-day lock.
 */
export function isMaterialChange(before: Registrant | null, after: Registrant): boolean {
  if (!before) return false
  return (
    squash(before.firstName) !== squash(after.firstName) ||
    squash(before.lastName) !== squash(after.lastName) ||
    squash(before.company) !== squash(after.company) ||
    squash(before.email) !== squash(after.email)
  )
}

const FIELDS: (keyof Contact)[] = [
  'firstName',
  'lastName',
  'company',
  'email',
  'phoneCountryCode',
  'phone',
  'addressLine1',
  'addressLine2',
  'addressLine3',
  'city',
  'state',
  'zipCode',
  'country',
]

/** Whether two registrants say the same thing, ignoring case and spacing. */
export function sameRegistrant(before: Registrant | null, after: Contact): boolean {
  if (!before) return false
  return FIELDS.every((field) => squash(before[field]) === squash(after[field]))
}
