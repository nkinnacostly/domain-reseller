import type { Contact } from '@dr/shared'
import { describe, expect, it } from 'vitest'
import { contactRoles, parseOtherContacts } from './contacts'

const ADA: Contact = {
  firstName: 'Ada',
  lastName: 'Obi',
  email: 'ada@example.com',
  phoneCountryCode: '234',
  phone: '8031234567',
  addressLine1: '1 Marina',
  city: 'Lagos',
  state: 'Lagos',
  zipCode: '100001',
  country: 'NG',
}
const TUNDE: Contact = { ...ADA, firstName: 'Tunde', email: 'tunde@example.com' }
const CHIOMA: Contact = { ...ADA, firstName: 'Chioma', email: 'chioma@example.com' }

describe('the other three contacts, as stored (FR-A4, migration 29)', () => {
  it.each([
    ['a list', [ADA]],
    ['a string', 'Ada'],
    ['a number', 7],
  ])('refuses %s: it is not an object of roles', (_case, value) => {
    expect(parseOtherContacts(value)).toBeNull()
  })

  it('refuses the whole set when any role is not a valid contact', () => {
    expect(parseOtherContacts({ technical: TUNDE, billing: { firstName: 'Bayo' } })).toBeNull()
    expect(parseOtherContacts({ administrative: { ...TUNDE, country: 'Nigeria' } })).toBeNull()
  })

  it('reads nothing stored as every role held by the registrant', () => {
    expect(parseOtherContacts(null)).toEqual({})
    expect(parseOtherContacts(undefined)).toEqual({})
    expect(parseOtherContacts({})).toEqual({})
  })

  it('reads a role set to null as held by the registrant', () => {
    expect(parseOtherContacts({ administrative: null, technical: TUNDE })).toEqual({
      technical: TUNDE,
    })
  })

  it('keeps the three roles and nothing else', () => {
    expect(
      parseOtherContacts({
        administrative: TUNDE,
        billing: { ...CHIOMA, unexpected: 'dropped' },
        registrant: ADA,
        owner: ADA,
      }),
    ).toEqual({ administrative: TUNDE, billing: CHIOMA })
  })
})

describe('the four roles to send', () => {
  it('puts the registrant in every role nobody else holds', () => {
    expect(contactRoles(ADA)).toEqual({
      registrant: ADA,
      administrative: ADA,
      technical: ADA,
      billing: ADA,
    })
  })

  it('uses each role’s own contact where there is one', () => {
    expect(contactRoles(ADA, { technical: TUNDE, billing: CHIOMA })).toEqual({
      registrant: ADA,
      administrative: ADA,
      technical: TUNDE,
      billing: CHIOMA,
    })
  })
})
