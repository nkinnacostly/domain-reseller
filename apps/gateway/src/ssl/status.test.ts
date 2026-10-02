import { describe, expect, it } from 'vitest'
import { isConfiguredWord, sslState, toSupplierContact } from './status'

describe('the supplier’s certificate words (Appendix E)', () => {
  it.each([
    ['WaitingForInstall', 'awaiting_setup'],
    ['WaitingForValidation', 'awaiting_validation'],
    ['Active', 'issued'],
    ['active', 'issued'],
    ['Expired', 'issued'],
    ['Revoked', 'revoked'],
    ['Cancelled', 'cancelled'],
    ['Canceled', 'cancelled'],
    ['Waiting_For_Install', 'awaiting_setup'],
    ['Suspended', null],
    ['', null],
    [null, null],
  ])('%s → %s', (word, state) => {
    expect(sslState(word)).toBe(state)
  })

  it('knows a set-up is in once the CA is validating or has issued', () => {
    expect(isConfiguredWord('WaitingForValidation')).toBe(true)
    expect(isConfiguredWord('Active')).toBe(true)
    expect(isConfiguredWord('WaitingForInstall')).toBe(false)
    expect(isConfiguredWord(undefined)).toBe(false)
  })
})

describe('our contact in the supplier’s shape', () => {
  const contact = {
    firstName: 'Ada',
    lastName: 'Okafor',
    email: 'ada@example.com',
    phoneCountryCode: '234',
    phone: '8031234567',
    addressLine1: '12 Admiralty Way',
    addressLine2: 'Lekki Phase 1',
    city: 'Lagos',
    state: 'Lagos',
    zipCode: '100001',
    country: 'NG',
  }

  it('sends the whole phone with its code, and the two-letter country where the code will not fit', () => {
    expect(toSupplierContact(contact)).toEqual({
      firstName: 'Ada',
      lastName: 'Okafor',
      companyName: 'Ada Okafor',
      eMail: 'ada@example.com',
      address: '12 Admiralty Way Lekki Phase 1',
      phoneCountryCode: 'NG',
      phone: '+2348031234567',
      faxCountryCode: 'NG',
      fax: '+2348031234567',
      country: 'NG',
      city: 'Lagos',
      state: 'Lagos',
      postalCode: '100001',
    })
  })

  it('names the company when there is one, and keeps a long number within 15 characters', () => {
    const sent = toSupplierContact({
      ...contact,
      company: 'Okafor Ventures',
      phone: '803123456789',
    })
    expect(sent.companyName).toBe('Okafor Ventures')
    expect(sent.phone).toBe('234803123456789')
    expect(sent.phone.length).toBeLessThanOrEqual(15)
  })
})
