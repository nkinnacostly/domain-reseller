import type { Contact } from '@dr/shared'
import { describe, expect, it } from 'vitest'
import type { Lookup, RegisterInput, Registrar, RegistryDomain, Write } from './registrar'
import { applyNameservers, type RegistrationTask, runRegistration, sameNameservers } from './saga'

/** A registrar that answers from a script and remembers what was asked. */
function scripted(script: {
  lookups?: Lookup[]
  register?: Write<RegistryDomain>
  setNameservers?: Write<string[]>
}) {
  const lookups = [...(script.lookups ?? [])]
  const log: string[] = []
  const sent: RegisterInput[] = []
  const registrar: Registrar = {
    async lookup() {
      log.push('lookup')
      const next = lookups.shift()
      if (!next) throw new Error('unexpected lookup')
      return next
    },
    async register(input) {
      log.push('register')
      sent.push(input)
      if (!script.register) throw new Error('unexpected register')
      return script.register
    },
    async renew() {
      throw new Error('a registration never renews')
    },
    async setNameservers() {
      log.push('setNameservers')
      if (!script.setNameservers) throw new Error('unexpected setNameservers')
      return script.setNameservers
    },
  }
  return { registrar, log, sent }
}

const DOMAIN: RegistryDomain = {
  registeredAt: '2026-09-23T10:00:00.000Z',
  expiresAt: '2027-09-23T10:00:00.000Z',
  nameservers: ['ns1.domainnameapi.com', 'ns2.domainnameapi.com'],
  transferLock: true,
  privacy: false,
}

const VERCEL = ['ns1.vercel-dns.com', 'ns2.vercel-dns.com']

const task = (over: Partial<RegistrationTask> = {}): RegistrationTask => ({
  domainName: 'example.com',
  periodYears: 1,
  privacy: false,
  contact: { firstName: 'Ada' } as Contact,
  nameservers: null,
  ...over,
})

const timedOut = { kind: 'unknown', code: 'TIMEOUT', message: 'No answer' } as const

describe('runRegistration', () => {
  it('always looks before registering (I1), and reads the record back after', async () => {
    const { registrar, log } = scripted({
      lookups: [{ kind: 'not_found' }, { kind: 'found', domain: DOMAIN }],
      register: { kind: 'ok', data: DOMAIN },
    })
    await expect(runRegistration(registrar, task())).resolves.toMatchObject({
      kind: 'registered',
      recovered: false,
    })
    expect(log).toEqual(['lookup', 'register', 'lookup'])
  })

  it('registers with the other three contacts it was given, and none it was not (FR-A4)', async () => {
    const tunde = { firstName: 'Tunde' } as Contact
    const script = {
      lookups: [{ kind: 'not_found' }, { kind: 'found', domain: DOMAIN }] as Lookup[],
      register: { kind: 'ok', data: DOMAIN } as const,
    }
    const given = scripted(script)
    await runRegistration(given.registrar, task({ contacts: { technical: tunde } }))
    expect(given.sent[0]).toMatchObject({ contacts: { technical: tunde } })

    const none = scripted(script)
    await runRegistration(none.registrar, task())
    expect(none.sent[0]).not.toHaveProperty('contacts')
  })

  it('records the registry’s full record, not the sparse register answer', async () => {
    const sparse = { ...DOMAIN, registeredAt: null, nameservers: [], transferLock: false }
    const { registrar } = scripted({
      lookups: [{ kind: 'not_found' }, { kind: 'found', domain: DOMAIN }],
      register: { kind: 'ok', data: sparse },
    })
    await expect(runRegistration(registrar, task())).resolves.toMatchObject({ domain: DOMAIN })
  })

  it('keeps the register answer when the read-back fails — it is still registered', async () => {
    const { registrar } = scripted({
      lookups: [{ kind: 'not_found' }, timedOut],
      register: { kind: 'ok', data: DOMAIN },
    })
    await expect(runRegistration(registrar, task())).resolves.toMatchObject({
      kind: 'registered',
      domain: DOMAIN,
    })
  })

  it('treats a name already registered to us as done, and registers nothing', async () => {
    const { registrar, log } = scripted({ lookups: [{ kind: 'found', domain: DOMAIN }] })
    await expect(runRegistration(registrar, task())).resolves.toMatchObject({
      kind: 'registered',
      recovered: true,
    })
    expect(log).toEqual(['lookup'])
  })

  it('does not register when it cannot tell whether the name is already ours', async () => {
    const { registrar, log } = scripted({ lookups: [timedOut] })
    await expect(runRegistration(registrar, task())).resolves.toMatchObject({ kind: 'unknown' })
    expect(log).toEqual(['lookup'])
  })

  describe('a registration that times out (I2)', () => {
    it('is settled by reading — found means registered', async () => {
      const { registrar, log } = scripted({
        lookups: [{ kind: 'not_found' }, { kind: 'found', domain: DOMAIN }],
        register: timedOut,
      })
      await expect(runRegistration(registrar, task())).resolves.toMatchObject({
        kind: 'registered',
        recovered: true,
      })
      expect(log).toEqual(['lookup', 'register', 'lookup'])
    })

    it('is never sent twice by the same attempt', async () => {
      const { registrar, log } = scripted({
        lookups: [{ kind: 'not_found' }, { kind: 'not_found' }],
        register: timedOut,
      })
      await expect(runRegistration(registrar, task())).resolves.toMatchObject({
        kind: 'not_registered',
        code: 'TIMEOUT',
      })
      expect(log.filter((step) => step === 'register')).toHaveLength(1)
    })

    it('stays unknown when the read cannot answer either', async () => {
      const { registrar } = scripted({
        lookups: [{ kind: 'not_found' }, timedOut],
        register: timedOut,
      })
      await expect(runRegistration(registrar, task())).resolves.toMatchObject({ kind: 'unknown' })
    })
  })

  it('fails a line the registry refuses, without asking again', async () => {
    const { registrar, log } = scripted({
      lookups: [{ kind: 'not_found' }],
      register: { kind: 'rejected', code: 'DOMAIN_TAKEN', message: 'Domain exists' },
    })
    await expect(runRegistration(registrar, task())).resolves.toEqual({
      kind: 'rejected',
      code: 'DOMAIN_TAKEN',
      message: 'Domain exists',
    })
    expect(log).toEqual(['lookup', 'register'])
  })

  it('reports blocked credentials as blocked', async () => {
    const { registrar } = scripted({
      lookups: [{ kind: 'blocked', code: 'SUPPLIER_AUTH', message: 'HTTP 401' }],
    })
    await expect(runRegistration(registrar, task())).resolves.toMatchObject({ kind: 'blocked' })
  })

  describe('nameservers from checkout (FR-R5)', () => {
    it('applies them after registering', async () => {
      const { registrar, log } = scripted({
        lookups: [{ kind: 'not_found' }, { kind: 'found', domain: DOMAIN }],
        register: { kind: 'ok', data: DOMAIN },
        setNameservers: { kind: 'ok', data: VERCEL },
      })
      const outcome = await runRegistration(registrar, task({ nameservers: VERCEL }))
      expect(outcome).toMatchObject({
        kind: 'registered',
        domain: { nameservers: VERCEL },
        nameservers: { result: 'applied' },
      })
      expect(log).toEqual(['lookup', 'register', 'lookup', 'setNameservers'])
    })

    it('never fails the registration when they are refused', async () => {
      const { registrar } = scripted({
        lookups: [{ kind: 'not_found' }, { kind: 'found', domain: DOMAIN }],
        register: { kind: 'ok', data: DOMAIN },
        setNameservers: { kind: 'rejected', code: 'NAMESERVER_INVALID', message: 'bad host' },
      })
      const outcome = await runRegistration(registrar, task({ nameservers: VERCEL }))
      expect(outcome).toMatchObject({
        kind: 'registered',
        domain: { nameservers: DOMAIN.nameservers },
        nameservers: { result: 'rejected', code: 'NAMESERVER_INVALID' },
      })
    })

    it('skips the change when a recovered registration already has them', async () => {
      const { registrar, log } = scripted({
        lookups: [{ kind: 'found', domain: { ...DOMAIN, nameservers: VERCEL } }],
      })
      await expect(
        runRegistration(registrar, task({ nameservers: VERCEL })),
      ).resolves.toMatchObject({
        nameservers: { result: 'applied' },
      })
      expect(log).toEqual(['lookup'])
    })

    it('reports none when checkout gave none', async () => {
      const { registrar } = scripted({ lookups: [{ kind: 'found', domain: DOMAIN }] })
      await expect(runRegistration(registrar, task())).resolves.toMatchObject({
        nameservers: { result: 'none' },
      })
    })
  })
})

describe('applyNameservers', () => {
  it('settles a timed-out change by reading the registry', async () => {
    const { registrar, log } = scripted({
      setNameservers: timedOut,
      lookups: [{ kind: 'found', domain: { ...DOMAIN, nameservers: VERCEL } }],
    })
    await expect(applyNameservers(registrar, 'example.com', VERCEL)).resolves.toEqual({
      result: 'applied',
      nameservers: VERCEL,
    })
    expect(log).toEqual(['setNameservers', 'lookup'])
  })

  it('stays unknown when the registry still shows the old set', async () => {
    const { registrar } = scripted({
      setNameservers: timedOut,
      lookups: [{ kind: 'found', domain: DOMAIN }],
    })
    await expect(applyNameservers(registrar, 'example.com', VERCEL)).resolves.toMatchObject({
      result: 'unknown',
    })
  })

  it('keeps blocked distinct from unknown', async () => {
    const { registrar } = scripted({
      setNameservers: { kind: 'blocked', code: 'SUPPLIER_AUTH', message: 'HTTP 401' },
      lookups: [{ kind: 'blocked', code: 'SUPPLIER_AUTH', message: 'HTTP 401' }],
    })
    await expect(applyNameservers(registrar, 'example.com', VERCEL)).resolves.toMatchObject({
      result: 'blocked',
    })
  })
})

describe('sameNameservers', () => {
  it('ignores order, case and a trailing dot', () => {
    expect(sameNameservers(['NS2.a.com.', 'ns1.a.com'], ['ns1.a.com', 'ns2.a.com'])).toBe(true)
  })

  it('notices a missing or extra host', () => {
    expect(sameNameservers(['ns1.a.com'], ['ns1.a.com', 'ns2.a.com'])).toBe(false)
  })
})
