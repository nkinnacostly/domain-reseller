import type { Contact } from '@dr/shared'
import { describe, expect, it, vi } from 'vitest'
import {
  asRegistryContact,
  type Lookup,
  type Reading,
  type RegistryContacts,
  type RegistryDomain,
  type SettingsRegistrar,
  type SettingWrite,
} from './registrar'
import { runSettingChange, sameContacts } from './settings'

const DOMAIN: RegistryDomain = {
  registeredAt: '2026-09-23T10:00:00.000Z',
  expiresAt: '2027-09-23T10:00:00.000Z',
  nameservers: ['ns1.domainnameapi.com', 'ns2.domainnameapi.com'],
  transferLock: true,
  privacy: false,
}

const ADA: Contact = {
  firstName: 'Ada',
  lastName: 'Obi',
  email: 'ada@example.com',
  phoneCountryCode: '234',
  phone: '8031234567',
  addressLine1: '1 Marina',
  addressLine2: 'Suite 4',
  city: 'Lagos',
  state: 'Lagos',
  zipCode: '100001',
  country: 'NG',
}
const BAYO: Contact = { ...ADA, firstName: 'Bayo', email: 'bayo@example.com' }

const all = (contact: Contact): RegistryContacts => {
  const held = asRegistryContact(contact)
  return { registrant: held, administrative: held, technical: held, billing: held }
}

const found = (over: Partial<RegistryDomain> = {}): Lookup => ({
  kind: 'found',
  domain: { ...DOMAIN, ...over },
})
const timedOut = { kind: 'unknown', code: 'TIMEOUT', message: 'No answer' } as const

/** A registry that answers reads in order and records every write. */
function registry(script: {
  lookups?: Lookup[]
  contacts?: Reading<RegistryContacts>[]
  write?: SettingWrite
}) {
  const lookups = [...(script.lookups ?? [])]
  const contacts = [...(script.contacts ?? [])]
  const write = vi.fn(async () => script.write ?? ({ kind: 'ok' } as const))
  const registrar: SettingsRegistrar = {
    lookup: async () => lookups.shift() ?? { kind: 'not_found' },
    contacts: async () => contacts.shift() ?? { kind: 'not_found' },
    setTransferLock: write,
    setPrivacy: write,
    updateContacts: write,
  }
  return { registrar, write }
}

const unlock = { kind: 'set_transfer_lock', domainName: 'example.com', requested: false } as const

describe('a setting change — the registry decides (I1, I2)', () => {
  it('writes nothing when the pre-flight read cannot be made', async () => {
    const { registrar, write } = registry({ lookups: [timedOut] })
    await expect(runSettingChange(registrar, unlock)).resolves.toEqual(timedOut)
    expect(write).not.toHaveBeenCalled()
  })

  it('refuses a domain the registry does not list in our account', async () => {
    const { registrar, write } = registry({ lookups: [{ kind: 'not_found' }] })
    await expect(runSettingChange(registrar, unlock)).resolves.toMatchObject({
      kind: 'rejected',
      code: 'DOMAIN_NOT_FOUND',
    })
    expect(write).not.toHaveBeenCalled()
  })

  it('records a refusal with its code, and does not read again', async () => {
    const { registrar } = registry({
      lookups: [found()],
      write: {
        kind: 'rejected',
        code: 'REGISTRY_REFUSED',
        message: 'Domain is locked by registry',
      },
    })
    await expect(runSettingChange(registrar, unlock)).resolves.toEqual({
      kind: 'rejected',
      code: 'REGISTRY_REFUSED',
      message: 'Domain is locked by registry',
    })
  })

  it('reports refused credentials as blocked, for operations', async () => {
    const { registrar } = registry({
      lookups: [found()],
      write: { kind: 'blocked', code: 'SUPPLIER_AUTH', message: 'HTTP 401' },
    })
    await expect(runSettingChange(registrar, unlock)).resolves.toMatchObject({ kind: 'blocked' })
  })

  it('never trusts an accepted write the record does not show', async () => {
    const { registrar } = registry({ lookups: [found(), found({ transferLock: true })] })
    await expect(runSettingChange(registrar, unlock)).resolves.toMatchObject({
      kind: 'unknown',
      code: 'NOT_YET_VISIBLE',
    })
  })

  it('settles a timeout by reading: the old value means it did not land (N3)', async () => {
    const { registrar, write } = registry({
      lookups: [found(), found({ transferLock: true })],
      write: timedOut,
    })
    await expect(runSettingChange(registrar, unlock)).resolves.toEqual({
      kind: 'not_applied',
      code: 'TIMEOUT',
      message: 'No answer',
    })
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('settles a timeout by reading: the new value means it landed', async () => {
    const { registrar } = registry({
      lookups: [found(), found({ transferLock: false })],
      write: timedOut,
    })
    await expect(runSettingChange(registrar, unlock)).resolves.toEqual({
      kind: 'applied',
      recovered: true,
    })
  })

  it('leaves a timeout unknown when the record cannot be read after it', async () => {
    const { registrar } = registry({ lookups: [found(), timedOut], write: timedOut })
    await expect(runSettingChange(registrar, unlock)).resolves.toMatchObject({
      kind: 'unknown',
      code: 'TIMEOUT',
    })
  })
})

describe('transfer lock (FR-DS4)', () => {
  it('writes nothing when the registry already holds it (I1)', async () => {
    const { registrar, write } = registry({ lookups: [found({ transferLock: false })] })
    await expect(runSettingChange(registrar, unlock)).resolves.toEqual({
      kind: 'applied',
      recovered: true,
    })
    expect(write).not.toHaveBeenCalled()
  })

  it('turns it off, then reads the record back', async () => {
    const { registrar, write } = registry({
      lookups: [found(), found({ transferLock: false })],
    })
    await expect(runSettingChange(registrar, unlock)).resolves.toEqual({
      kind: 'applied',
      recovered: false,
    })
    expect(write).toHaveBeenCalledWith('example.com', false)
  })
})

describe('privacy (FR-DS3)', () => {
  it('turns it on, then reads the record back', async () => {
    const { registrar, write } = registry({ lookups: [found(), found({ privacy: true })] })
    await expect(
      runSettingChange(registrar, {
        kind: 'set_privacy',
        domainName: 'example.com',
        requested: true,
      }),
    ).resolves.toEqual({ kind: 'applied', recovered: false })
    expect(write).toHaveBeenCalledWith('example.com', true)
  })
})

describe('contacts (FR-DS1)', () => {
  const change = { kind: 'update_contacts', domainName: 'example.com', requested: BAYO } as const
  const held = (contacts: RegistryContacts): Reading<RegistryContacts> => ({
    kind: 'found',
    data: contacts,
  })

  it('writes nothing when the registry already holds the new details', async () => {
    const { registrar, write } = registry({ contacts: [held(all(BAYO))] })
    await expect(runSettingChange(registrar, change)).resolves.toEqual({
      kind: 'applied',
      recovered: true,
    })
    expect(write).not.toHaveBeenCalled()
  })

  it('saves the new registrant, and calls it applied only when the read shows it', async () => {
    const { registrar, write } = registry({ contacts: [held(all(ADA)), held(all(BAYO))] })
    await expect(runSettingChange(registrar, change)).resolves.toEqual({
      kind: 'applied',
      recovered: false,
    })
    expect(write).toHaveBeenCalledWith('example.com', BAYO)
  })

  it('does not call it applied while any role the registry shows still differs', async () => {
    const { registrar } = registry({
      contacts: [held(all(ADA)), held({ ...all(BAYO), technical: asRegistryContact(ADA) })],
    })
    await expect(runSettingChange(registrar, change)).resolves.toMatchObject({
      kind: 'unknown',
      code: 'NOT_YET_VISIBLE',
    })
  })

  it('settles a timeout by reading: the old details mean it did not land', async () => {
    const { registrar } = registry({
      contacts: [held(all(ADA)), held(all(ADA))],
      write: timedOut,
    })
    await expect(runSettingChange(registrar, change)).resolves.toMatchObject({
      kind: 'not_applied',
    })
  })

  it('leaves a timeout unknown when the read shows neither the old details nor the new', async () => {
    const { registrar } = registry({
      contacts: [held(all(ADA)), held(all({ ...ADA, city: 'Abuja' }))],
      write: timedOut,
    })
    await expect(runSettingChange(registrar, change)).resolves.toMatchObject({ kind: 'unknown' })
  })

  it('refuses a domain the registry does not list, and passes other failed reads on', async () => {
    await expect(
      runSettingChange(registry({ contacts: [{ kind: 'not_found' }] }).registrar, change),
    ).resolves.toMatchObject({ kind: 'rejected', code: 'DOMAIN_NOT_FOUND' })
    await expect(
      runSettingChange(registry({ contacts: [timedOut] }).registrar, change),
    ).resolves.toEqual(timedOut)
  })
})

describe('sameContacts', () => {
  it('compares only the roles the registry shows, the registrant always', () => {
    const shown = { registrant: asRegistryContact(ADA) }
    expect(sameContacts(shown, all(ADA))).toBe(true)
    expect(sameContacts(shown, all(BAYO))).toBe(false)
    expect(sameContacts({}, all(ADA))).toBe(false)
  })

  it('reads the registry’s normalising as the same details', () => {
    const registry = {
      ...asRegistryContact(ADA),
      firstName: 'ADA',
      email: ' Ada@Example.com ',
      address: '1  Marina Suite 4',
      phoneCountryCode: '',
      phone: '+234.8031234567',
    }
    expect(sameContacts({ registrant: registry }, all(ADA))).toBe(true)
  })
})
