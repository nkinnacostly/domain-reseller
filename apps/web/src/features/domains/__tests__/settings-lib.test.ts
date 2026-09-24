import type { Contact } from '@dr/shared'
import { describe, expect, it } from 'vitest'
import { describeEvent } from '../lib/activity'
import {
  isCountryCodeTld,
  isMaterialChange,
  pendingLabel,
  privacyOffered,
  sameRegistrant,
  settingsAvailability,
  transferCodeUnavailable,
  transferWindowEnds,
} from '../lib/settings'

const ADA: Contact = {
  firstName: 'Ada',
  lastName: 'Okafor',
  email: 'ada@example.com',
  phoneCountryCode: '234',
  phone: '8031234567',
  addressLine1: '1 Marina',
  city: 'Lagos',
  state: 'Lagos',
  zipCode: '100001',
  country: 'NG',
}

const live = { status: 'active', source: 'registration', testMode: false } as const

describe('privacy by extension (FR-DS3)', () => {
  it('is offered on generic extensions only, as at checkout', () => {
    expect(privacyOffered('com')).toBe(true)
    expect(privacyOffered('online')).toBe(true)
    expect(privacyOffered('ng')).toBe(false)
    expect(privacyOffered('com.ng')).toBe(false)
    expect(isCountryCodeTld('co')).toBe(true)
  })
})

describe('which domains can change their settings', () => {
  it('never offers a demo domain a change: nothing reaches a registry', () => {
    expect(settingsAvailability({ ...live, source: 'demo' })).toMatchObject({
      editable: false,
      note: { title: 'Demo domain.' },
    })
  })

  it('waits for a registration to complete', () => {
    expect(settingsAvailability({ ...live, status: 'pending' })).toMatchObject({
      editable: false,
      note: { title: 'Registering.' },
    })
  })

  it('refuses a domain that is not active or in grace', () => {
    expect(settingsAvailability({ ...live, status: 'redemption' }).editable).toBe(false)
    expect(settingsAvailability({ ...live, status: 'expired_grace' }).editable).toBe(true)
  })

  it('labels a sandbox domain’s changes as going to the test system', () => {
    expect(settingsAvailability({ ...live, testMode: true })).toEqual({
      editable: true,
      note: {
        title: 'Sandbox domain.',
        body: 'Changes go to the registrar’s test system, not the live registry.',
      },
    })
    expect(settingsAvailability(live)).toEqual({ editable: true, note: null })
  })
})

describe('pendingLabel', () => {
  it('says which way a change is going while the registry has not confirmed it', () => {
    expect(pendingLabel(false)).toBe('Turning off — waiting for the registry')
    expect(pendingLabel(true)).toBe('Turning on — waiting for the registry')
    expect(pendingLabel(null)).toBeNull()
  })
})

describe('the transfer code (FR-DS5, N14)', () => {
  it('is given for every state the registry holds the domain for us — billing is never asked', () => {
    for (const status of [
      'active',
      'expired_grace',
      'redemption',
      'pending_verification',
    ] as const) {
      expect(transferCodeUnavailable({ ...live, status })).toBeNull()
    }
  })

  it('says why there is none', () => {
    expect(transferCodeUnavailable({ ...live, source: 'demo' })).toMatch(/demo domain/)
    expect(transferCodeUnavailable({ ...live, status: 'pending' })).toMatch(
      /registration completes/,
    )
    expect(transferCodeUnavailable({ ...live, status: 'transferred_away' })).toMatch(
      /no longer held/,
    )
  })
})

describe('the 60-day window (FR-T7)', () => {
  const now = new Date('2026-09-24T12:00:00Z')

  it('gives the exact date from the latest registration or transfer', () => {
    expect(
      transferWindowEnds(['2026-01-01T00:00:00Z', '2026-09-01T00:00:00Z'], now)?.toISOString(),
    ).toBe('2026-10-31T00:00:00.000Z')
  })

  it('is over after 60 days, and absent without a date', () => {
    expect(transferWindowEnds(['2026-06-01T00:00:00Z'], now)).toBeNull()
    expect(transferWindowEnds([null, 'not a date'], now)).toBeNull()
  })
})

describe('a change of registrant (PRD §7.3, FR-DS2)', () => {
  it('is a new name, organisation or email', () => {
    expect(isMaterialChange(ADA, { ...ADA, lastName: 'Obi' })).toBe(true)
    expect(isMaterialChange(ADA, { ...ADA, company: 'Okafor Ltd' })).toBe(true)
    expect(isMaterialChange(ADA, { ...ADA, email: 'ada@okafor.ng' })).toBe(true)
  })

  it('is not a new address or phone, a change of case, or a first registrant', () => {
    expect(isMaterialChange(ADA, { ...ADA, addressLine1: '2 Broad St', phone: '8039999999' })).toBe(
      false,
    )
    expect(isMaterialChange(ADA, { ...ADA, firstName: ' ADA ' })).toBe(false)
    expect(isMaterialChange(null, ADA)).toBe(false)
  })

  it('tells an unchanged registrant apart from any edit', () => {
    expect(sameRegistrant(ADA, { ...ADA, email: 'ADA@example.com' })).toBe(true)
    expect(sameRegistrant(ADA, { ...ADA, city: 'Abuja' })).toBe(false)
    expect(sameRegistrant(null, ADA)).toBe(false)
  })
})

describe('activity for registry-side settings', () => {
  it('says what was asked for, and what the registry did', () => {
    expect(describeEvent('transfer_lock_requested', { to: false })).toBe(
      'Asked to turn the transfer lock off',
    )
    expect(describeEvent('transfer_lock_applied', { transfer_lock: false })).toBe(
      'Transfer lock turned off at the registry',
    )
    expect(describeEvent('privacy_requested', { to: true })).toBe(
      'Asked to turn contact privacy on',
    )
    expect(describeEvent('privacy_applied', { privacy: true })).toBe(
      'Contact privacy turned on at the registry',
    )
    expect(describeEvent('contacts_requested', { material: true })).toBe(
      'Asked to change the registrant',
    )
    expect(describeEvent('contacts_applied', {})).toBe('Registrant updated at the registry')
  })

  it('explains refusals in our words, never the supplier’s (N10)', () => {
    expect(describeEvent('transfer_lock_rejected', { code: 'DOMAIN_NOT_FOUND' })).toBe(
      'Transfer lock change refused by the registry: The registry does not list this domain in our account.',
    )
    expect(describeEvent('privacy_rejected', { code: 'REGISTRY_REFUSED' })).toBe(
      'Contact privacy change refused by the registry: The registry could not complete it.',
    )
    expect(describeEvent('contacts_rejected', { code: 'CONTACT_INVALID' })).toBe(
      'Registrant change refused by the registry: The registry rejected the contact details.',
    )
  })

  it('says a delay is the registry’s, and when a change was given up on', () => {
    expect(describeEvent('transfer_lock_delayed', {})).toBe(
      'Transfer lock change delayed — waiting on the registry',
    )
    expect(describeEvent('privacy_delayed', {})).toBe(
      'Contact privacy change delayed — waiting on the registry',
    )
    expect(describeEvent('contacts_delayed', {})).toBe(
      'Registrant change delayed — waiting on the registry',
    )
    expect(describeEvent('transfer_lock_not_applied', {})).toBe('Transfer lock change not applied')
    expect(describeEvent('privacy_not_applied', {})).toBe('Contact privacy change not applied')
    expect(describeEvent('contacts_not_applied', {})).toBe('Registrant change not applied')
  })

  it('records a transfer code being shown, and where it came from — never the code', () => {
    expect(describeEvent('auth_code_revealed', {})).toBe('Transfer code shown')
    expect(describeEvent('auth_code_revealed', { sandbox: true })).toBe(
      'Transfer code shown, from the registrar’s test system',
    )
  })

  it('still falls back to the raw words for anything unknown', () => {
    expect(describeEvent('something_new', {})).toBe('something new')
  })
})
