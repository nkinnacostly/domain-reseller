import { describe, expect, it } from 'vitest'
import { errorAt } from '../lib/errors'
import type { ContactProfile } from '../lib/profiles'
import {
  contactRolesFromForm,
  contactRolesInputSchema,
  heldByOthers,
  readRoles,
  registrantAlsoHolds,
  roleChoiceFromForm,
  roleChoiceSchema,
  roleStart,
  sameContact,
  sameRoles,
  withRole,
} from '../lib/roles'

const ADA = {
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
const BOLA = { ...ADA, firstName: 'Bola', lastName: 'Ade', email: 'accounts@example.com' }
const PROFILE_ID = '7d7f7a0e-1c61-4c4f-9f7e-0a6a2f9b1a11'

function form(entries: Record<string, string>) {
  const data = new FormData()
  for (const [name, value] of Object.entries(entries)) data.set(name, value)
  return data
}

describe('roleChoiceSchema (FR-A4)', () => {
  it('refuses a saved contact without one chosen, and new details that fail the registrant’s checks', () => {
    const noProfile = roleChoiceSchema.safeParse({ kind: 'profile', profileId: '' })
    expect(noProfile.success).toBe(false)
    expect(noProfile.error?.issues[0]?.message).toBe('Choose a saved contact')

    const blank = roleChoiceSchema.safeParse({ kind: 'new', contact: { ...ADA, firstName: '' } })
    expect(blank.success).toBe(false)
    expect(blank.error?.issues[0]?.path).toEqual(['contact', 'firstName'])
  })

  it('refuses a kind it does not know', () => {
    expect(roleChoiceSchema.safeParse({ kind: 'someone' }).success).toBe(false)
  })

  it('takes the registrant, a saved contact by id, or new details', () => {
    expect(roleChoiceSchema.parse({ kind: 'registrant', contact: ADA })).toEqual({
      kind: 'registrant',
    })
    expect(roleChoiceSchema.parse({ kind: 'profile', profileId: PROFILE_ID })).toEqual({
      kind: 'profile',
      profileId: PROFILE_ID,
    })
    expect(
      roleChoiceSchema.parse({ kind: 'new', contact: { ...ADA, email: ' ADA@Example.com ' } }),
    ).toMatchObject({ kind: 'new', contact: { email: 'ada@example.com' } })
  })

  it('lets checkout leave any role out', () => {
    expect(contactRolesInputSchema.parse({})).toEqual({})
  })
})

describe('reading a role from the form', () => {
  it('reads the registrant when nothing was chosen', () => {
    expect(roleChoiceFromForm(form({}))).toEqual({ kind: 'registrant' })
  })

  it('reads a saved contact’s id, and new details under the role’s prefix', () => {
    expect(roleChoiceFromForm(form({ choice: 'profile', profileId: PROFILE_ID }))).toEqual({
      kind: 'profile',
      profileId: PROFILE_ID,
    })
    expect(roleChoiceFromForm(form({ choice: 'profile' }))).toEqual({
      kind: 'profile',
      profileId: '',
    })
    const prefixed = Object.fromEntries(
      Object.entries(ADA).map(([name, value]) => [`contacts.billing.${name}`, value]),
    )
    expect(
      roleChoiceFromForm(
        form({ 'contacts.billing.choice': 'new', ...prefixed }),
        'contacts.billing.',
      ),
    ).toEqual({ kind: 'new', contact: { ...ADA, company: '', addressLine2: '' } })
  })

  it('sends nothing for checkout when every role stays with the registrant', () => {
    expect(contactRolesFromForm(form({ 'contacts.billing.choice': 'registrant' }))).toBeUndefined()
  })

  it('sends only the roles given to someone else', () => {
    expect(
      contactRolesFromForm(
        form({
          'contacts.administrative.choice': 'registrant',
          'contacts.billing.choice': 'profile',
          'contacts.billing.profileId': PROFILE_ID,
        }),
      ),
    ).toEqual({ billing: { kind: 'profile', profileId: PROFILE_ID } })
  })
})

describe('stored roles (migration 29)', () => {
  it('reads anything that is not an object as no roles, and ignores keys that are not roles', () => {
    expect(readRoles(null)).toEqual({})
    expect(readRoles('billing')).toEqual({})
    expect(readRoles([ADA])).toEqual({})
    expect(readRoles({ billing: BOLA, registrant: ADA, technical: 'x' })).toEqual({
      billing: BOLA,
    })
  })

  it('compares contacts ignoring case and spacing, and a missing one only with another', () => {
    expect(sameContact(ADA, { ...ADA, email: 'ADA@example.com ' })).toBe(true)
    expect(sameContact(ADA, BOLA)).toBe(false)
    expect(sameContact(undefined, ADA)).toBe(false)
    expect(sameContact(undefined, undefined)).toBe(true)
  })

  it('compares every role', () => {
    expect(sameRoles({ billing: BOLA }, { billing: { ...BOLA, city: 'lagos' } })).toBe(true)
    expect(sameRoles({ billing: BOLA }, {})).toBe(false)
    expect(sameRoles({}, {})).toBe(true)
  })

  it('sets a role, or hands it back to the registrant, without touching the others', () => {
    const roles = { technical: ADA }
    expect(withRole(roles, 'billing', BOLA)).toEqual({ technical: ADA, billing: BOLA })
    expect(withRole({ technical: ADA, billing: BOLA }, 'billing', null)).toEqual({
      technical: ADA,
    })
    expect(roles).toEqual({ technical: ADA })
  })

  it('leaves out a role whose contact is the registrant', () => {
    expect(heldByOthers({ administrative: ADA, billing: BOLA }, ADA)).toEqual({ billing: BOLA })
    expect(heldByOthers({ billing: BOLA }, null)).toEqual({ billing: BOLA })
  })

  it('says which roles the registrant also holds', () => {
    expect(registrantAlsoHolds({})).toBe('Also the administrative, technical and billing contact.')
    expect(registrantAlsoHolds({ administrative: BOLA })).toBe(
      'Also the technical and billing contact.',
    )
    expect(registrantAlsoHolds({ administrative: BOLA, technical: BOLA })).toBe(
      'Also the billing contact.',
    )
    expect(registrantAlsoHolds({ administrative: BOLA, technical: BOLA, billing: BOLA })).toBe(null)
  })
})

describe('where a role’s picker starts', () => {
  const saved: ContactProfile = {
    id: PROFILE_ID,
    label: 'Accounts',
    isDefault: false,
    values: { ...BOLA, company: '', addressLine2: '' },
  }

  it('starts at the registrant for a role it holds', () => {
    expect(roleStart(undefined, [saved])).toEqual({ kind: 'registrant' })
  })

  it('starts at the saved contact with the same details', () => {
    expect(roleStart(BOLA, [saved])).toEqual({ kind: 'profile', profileId: PROFILE_ID })
  })

  it('starts from the details themselves when no saved contact matches', () => {
    expect(roleStart(ADA, [saved])).toEqual({ kind: 'new', values: ADA })
  })
})

describe('errorAt', () => {
  it('finds a message deep in next-safe-action’s formatted errors', () => {
    const errors = { contacts: { billing: { contact: { city: { _errors: ['Enter a city'] } } } } }
    expect(errorAt(errors, ['contacts', 'billing', 'contact', 'city'])).toBe('Enter a city')
    expect(errorAt(errors, ['contacts', 'technical', 'contact', 'city'])).toBeUndefined()
    expect(errorAt(undefined, ['label'])).toBeUndefined()
  })
})
