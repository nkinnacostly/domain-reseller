import { describe, expect, it } from 'vitest'
import { toContact } from '@/features/checkout/lib/contact'
import {
  type ProfileRow,
  profileFormSchema,
  profileFromRow,
  profileOption,
  rowFromContact,
} from '../lib/profiles'

const ROW: ProfileRow = {
  id: 'profile-1',
  label: 'Accounts',
  is_default: false,
  first_name: 'Bola',
  last_name: 'Ade',
  company: null,
  email: 'accounts@example.com',
  phone: '8031234567',
  phone_country_code: '234',
  address_line1: '1 Marina',
  address_line2: null,
  city: 'Lagos',
  state: 'Lagos',
  zip_code: '100001',
  country: 'NG',
}

describe('contact profiles (FR-A4)', () => {
  it('shows a stored profile in the contact fields, blanks for what it lacks', () => {
    expect(profileFromRow(ROW)).toEqual({
      id: 'profile-1',
      label: 'Accounts',
      isDefault: false,
      values: {
        firstName: 'Bola',
        lastName: 'Ade',
        company: '',
        email: 'accounts@example.com',
        phoneCountryCode: '234',
        phone: '8031234567',
        addressLine1: '1 Marina',
        addressLine2: '',
        city: 'Lagos',
        state: 'Lagos',
        zipCode: '100001',
        country: 'NG',
      },
    })
  })

  it('offers a profile to a picker by its name and whose it is — nothing more (N13)', () => {
    expect(profileOption(profileFromRow(ROW))).toEqual({
      id: 'profile-1',
      label: 'Accounts',
      name: 'Bola Ade',
    })
  })

  it('stores a Nigerian number in E.164 parts: code 234, no trunk 0', () => {
    const contact = toContact(
      profileFormSchema.parse({
        label: 'Office',
        isDefault: true,
        contact: { ...profileFromRow(ROW).values, phone: '0803 123 4567', company: 'Paidly' },
      }).contact,
    )
    expect(rowFromContact(contact)).toEqual({
      first_name: 'Bola',
      last_name: 'Ade',
      company: 'Paidly',
      email: 'accounts@example.com',
      phone: '8031234567',
      phone_country_code: '234',
      address_line1: '1 Marina',
      address_line2: null,
      city: 'Lagos',
      state: 'Lagos',
      zip_code: '100001',
      country: 'NG',
    })
  })

  it('asks for a name, and keeps it short', () => {
    const values = profileFromRow(ROW).values
    const blank = profileFormSchema.safeParse({ label: '  ', isDefault: false, contact: values })
    expect(blank.error?.issues[0]?.message).toBe('Give this contact a name')
    const long = profileFormSchema.safeParse({
      label: 'x'.repeat(65),
      isDefault: false,
      contact: values,
    })
    expect(long.error?.issues[0]?.message).toBe('Keep the name under 64 characters')
  })
})
