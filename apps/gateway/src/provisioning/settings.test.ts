import type { Contact } from '@dr/shared'
import { describe, expect, it, vi } from 'vitest'
import { type ContactRoles, contactRoles } from './contacts'
import {
  asRegistryContact,
  type Lookup,
  type Reading,
  type RegistryContacts,
  type RegistryDomain,
  type SettingsRegistrar,
  type SettingWrite,
} from './registrar'
import { heldContacts, runSettingChange, sameContacts } from './settings'

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
      held: { transfer_lock: false },
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
      held: { transfer_lock: false },
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
      held: { transfer_lock: false },
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
    ).resolves.toEqual({ kind: 'applied', recovered: false, held: { privacy: true } })
    expect(write).toHaveBeenCalledWith('example.com', true)
  })
})

describe('contacts (FR-DS1): all four roles', () => {
  const TUNDE: Contact = { ...ADA, firstName: 'Tunde', email: 'tunde@example.com' }
  const CHIOMA: Contact = { ...ADA, firstName: 'Chioma', email: 'chioma@example.com' }

  /** What the registry shows for these four roles. */
  const shown = (roles: ContactRoles): Reading<RegistryContacts> => ({
    kind: 'found',
    data: {
      registrant: asRegistryContact(roles.registrant),
      administrative: asRegistryContact(roles.administrative),
      technical: asRegistryContact(roles.technical),
      billing: asRegistryContact(roles.billing),
    },
  })
  const change = (requested: ContactRoles) =>
    ({ kind: 'update_contacts', domainName: 'example.com', requested }) as const

  const today = contactRoles(ADA)
  const four = contactRoles(ADA, { administrative: BAYO, technical: TUNDE, billing: CHIOMA })

  it('refuses a domain the registry does not list, and passes other failed reads on', async () => {
    await expect(
      runSettingChange(registry({ contacts: [{ kind: 'not_found' }] }).registrar, change(four)),
    ).resolves.toMatchObject({ kind: 'rejected', code: 'DOMAIN_NOT_FOUND' })
    await expect(
      runSettingChange(registry({ contacts: [timedOut] }).registrar, change(four)),
    ).resolves.toEqual(timedOut)
  })

  it('does not call it applied while any role still differs', async () => {
    const { registrar } = registry({
      contacts: [shown(today), shown({ ...four, technical: ADA })],
    })
    await expect(runSettingChange(registrar, change(four))).resolves.toMatchObject({
      kind: 'unknown',
      code: 'NOT_YET_VISIBLE',
    })
  })

  it('does not call it applied while the registry does not show a role', async () => {
    const { billing: _billing, ...three } = (shown(four) as { data: RegistryContacts }).data
    const { registrar } = registry({ contacts: [shown(today), { kind: 'found', data: three }] })
    await expect(runSettingChange(registrar, change(four))).resolves.toMatchObject({
      kind: 'unknown',
      code: 'NOT_YET_VISIBLE',
    })
  })

  it('settles a timeout by reading: the old details mean it did not land (N3)', async () => {
    const { registrar, write } = registry({
      contacts: [shown(today), shown(today)],
      write: timedOut,
    })
    await expect(runSettingChange(registrar, change(four))).resolves.toMatchObject({
      kind: 'not_applied',
    })
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('leaves a timeout unknown when the read shows neither the old details nor the new', async () => {
    const { registrar } = registry({
      contacts: [shown(today), shown({ ...four, billing: ADA })],
      write: timedOut,
    })
    await expect(runSettingChange(registrar, change(four))).resolves.toMatchObject({
      kind: 'unknown',
    })
  })

  it('settles a timeout by reading: all four new contacts mean it landed', async () => {
    const { registrar } = registry({ contacts: [shown(today), shown(four)], write: timedOut })
    await expect(runSettingChange(registrar, change(four))).resolves.toMatchObject({
      kind: 'applied',
      recovered: true,
    })
  })

  it('writes nothing when the registry already holds all four, and records them (I1)', async () => {
    const wanted = contactRoles(ADA, { technical: TUNDE })
    const { registrar, write } = registry({ contacts: [shown(wanted)] })
    await expect(runSettingChange(registrar, change(wanted))).resolves.toEqual({
      kind: 'applied',
      recovered: true,
      held: { registrant: ADA, contacts: { technical: TUNDE } },
    })
    expect(write).not.toHaveBeenCalled()
  })

  it('saves four different people, and records each role the registrant does not hold', async () => {
    const { registrar, write } = registry({ contacts: [shown(today), shown(four)] })
    await expect(runSettingChange(registrar, change(four))).resolves.toEqual({
      kind: 'applied',
      recovered: false,
      held: {
        registrant: ADA,
        contacts: { administrative: BAYO, technical: TUNDE, billing: CHIOMA },
      },
    })
    expect(write).toHaveBeenCalledWith('example.com', four)
  })

  it('records {} once the registrant holds every role again', async () => {
    const { registrar } = registry({ contacts: [shown(four), shown(today)] })
    await expect(runSettingChange(registrar, change(today))).resolves.toMatchObject({
      kind: 'applied',
      held: { registrant: ADA, contacts: {} },
    })
  })

  it('records a role the registry cannot tell from the registrant under the registrant', async () => {
    // Asked for separately, but the same person once the registry normalises it.
    const shouted = { ...ADA, firstName: 'ADA', email: 'ADA@EXAMPLE.COM' }
    const wanted = contactRoles(ADA, { administrative: shouted })
    const { registrar, write } = registry({ contacts: [shown(today)] })
    await expect(runSettingChange(registrar, change(wanted))).resolves.toMatchObject({
      kind: 'applied',
      held: { registrant: ADA, contacts: {} },
    })
    expect(write).not.toHaveBeenCalled()
  })
})

describe('sameContacts', () => {
  it('compares all four roles: one missing from either side is a difference', () => {
    const held = all(ADA)
    const { technical: _technical, ...three } = all(ADA)
    expect(sameContacts(held, all(ADA))).toBe(true)
    expect(sameContacts(held, all(BAYO))).toBe(false)
    expect(sameContacts({ registrant: asRegistryContact(ADA) }, all(ADA))).toBe(false)
    expect(sameContacts(held, three)).toBe(false)
    expect(sameContacts({}, {})).toBe(false)
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
    const shown = {
      registrant: registry,
      administrative: registry,
      technical: registry,
      billing: registry,
    }
    expect(sameContacts(shown, all(ADA))).toBe(true)
  })
})

describe('heldContacts', () => {
  it('records no role the registry does not show, and none without a registrant to compare', () => {
    const sent = contactRoles(ADA, { technical: BAYO })
    expect(heldContacts({ registrant: asRegistryContact(ADA) }, sent)).toEqual({
      registrant: ADA,
      contacts: {},
    })
    expect(heldContacts({ technical: asRegistryContact(BAYO) }, sent)).toEqual({
      registrant: ADA,
      contacts: {},
    })
  })
})
