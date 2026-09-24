import { describe, expect, it, vi } from 'vitest'
import {
  asRegistryContact,
  type Lookup,
  type Reading,
  type Registrar,
  type RegistryContacts,
  type RegistryDomain,
  type SettingsRegistrar,
  type SettingWrite,
  type Write,
} from './registrar'
import type { ClaimedJob, Completion, JobStore } from './store'
import { createWorker, defaultBackoff } from './worker'

const REGISTRANT = {
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

const DOMAIN: RegistryDomain = {
  registeredAt: '2026-09-23T10:00:00.000Z',
  expiresAt: '2027-09-23T10:00:00.000Z',
  nameservers: ['ns1.domainnameapi.com', 'ns2.domainnameapi.com'],
  transferLock: true,
  privacy: false,
}

const VERCEL = ['ns1.vercel-dns.com', 'ns2.vercel-dns.com']

const job = (over: Partial<ClaimedJob> = {}): ClaimedJob => ({
  id: 'job-1',
  kind: 'register_domain',
  attempts: 1,
  testMode: true,
  domainId: 'domain-1',
  domainName: 'example.com',
  localStatus: 'pending',
  privacy: false,
  registrant: REGISTRANT,
  pendingNameservers: null,
  periodYears: 1,
  expiresAt: null,
  baselineExpiry: null,
  payment: {
    orderTxRef: 'MDH-2f1c1a3e-8d7b-4c55-9a0e-1f2d3c4b5a69',
    orderTotalKobo: 1_978_000,
    reference: '4242',
    amountKobo: 1_978_000,
    currency: 'NGN',
    status: 'successful',
  },
  ...over,
})

/** An in-memory queue holding at most one job, recording what the worker did. */
function fakeStore(claimed: ClaimedJob | null) {
  let next = claimed
  const actions: { type: string; args: unknown[] }[] = []
  const record =
    (type: string) =>
    async (...args: unknown[]) => {
      actions.push({ type, args })
    }
  const store: JobStore & { claimArgs: unknown[][] } = {
    claimArgs: [],
    async claim(...args) {
      store.claimArgs.push(args)
      const taken = next
      next = null
      return taken
    },
    recordCall: record('recordCall'),
    completeRegistration: record('complete') as JobStore['completeRegistration'],
    noteRenewalBaseline: async (...args: [string, string]) => {
      actions.push({ type: 'baseline', args })
      return args[1]
    },
    completeRenewal: record('renewed') as JobStore['completeRenewal'],
    recordNameserverChange: record('nameservers') as JobStore['recordNameserverChange'],
    recordDomainChange: record('setting') as JobStore['recordDomainChange'],
    reschedule: record('reschedule') as JobStore['reschedule'],
    fail: record('fail') as JobStore['fail'],
  }
  return { store, actions }
}

function registrar(script: {
  lookups?: Lookup[]
  register?: Write<RegistryDomain>
  renew?: Write<{ expiresAt: string | null }>
  setNameservers?: Write<string[]>
}): Registrar {
  const lookups = [...(script.lookups ?? [])]
  return {
    lookup: async () => lookups.shift() ?? { kind: 'not_found' },
    register: async () => script.register ?? { kind: 'ok', data: DOMAIN },
    renew: async () => script.renew ?? { kind: 'ok', data: { expiresAt: null } },
    setNameservers: async () => script.setNameservers ?? { kind: 'ok', data: VERCEL },
  }
}

const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function worker(claimed: ClaimedJob | null, reg: Registrar, over = {}) {
  const { store, actions } = fakeStore(claimed)
  const instance = createWorker({
    store,
    registrarFor: () => reg,
    checkPayment: async () => ({ kind: 'verified' }),
    testMode: true,
    workerId: 'test-worker',
    pollMs: 10,
    log: silent,
    ...over,
  })
  return { instance, store, actions }
}

const timedOut = { kind: 'unknown', code: 'TIMEOUT', message: 'No answer' } as const

describe('provisioning worker — the charge comes first (SEC-7)', () => {
  /** A registrar that fails the test if anything reaches the registry. */
  const untouchable: Registrar = {
    lookup: async () => {
      throw new Error('the registry was read before the payment was confirmed')
    },
    register: async () => {
      throw new Error('registered without a confirmed payment')
    },
    renew: async () => {
      throw new Error('renewed without a confirmed payment')
    },
    setNameservers: async () => {
      throw new Error('nameservers set without a confirmed payment')
    },
  }

  it('asks about the job’s own charge before anything reaches the registry', async () => {
    const checkPayment = vi.fn(async () => ({ kind: 'verified' }) as const)
    const { instance, actions } = worker(job(), registrar({}), { checkPayment })
    await instance.tick()
    expect(checkPayment).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-1' }))
    expect(actions[0]?.type).toBe('complete')
  })

  it('never registers for a charge Flutterwave does not confirm — and never refunds it', async () => {
    const { instance, actions } = worker(job(), untouchable, {
      checkPayment: async () => ({
        kind: 'refused',
        code: 'PAYMENT_NOT_VERIFIED',
        message: 'The charge is for another reference',
      }),
    })
    await instance.tick()
    // Needs a person (true), so the line is not failed and no refund is queued.
    expect(actions).toEqual([
      {
        type: 'fail',
        args: ['job-1', 'PAYMENT_NOT_VERIFIED', 'The charge is for another reference', true],
      },
    ])
  })

  it('waits when Flutterwave cannot be asked, and touches nothing', async () => {
    const { instance, actions } = worker(job(), untouchable, {
      checkPayment: async () => ({ kind: 'unknown', code: 'FLW_NO_ANSWER', message: 'timeout' }),
    })
    await instance.tick()
    expect(actions).toEqual([
      { type: 'reschedule', args: ['job-1', 30, 'FLW_NO_ANSWER', 'timeout'] },
    ])
  })

  it('does not ask about a payment to change nameservers', async () => {
    const checkPayment = vi.fn()
    const { instance } = worker(
      job({ kind: 'apply_nameservers', localStatus: 'active', pendingNameservers: VERCEL }),
      registrar({}),
      { checkPayment },
    )
    await instance.tick()
    expect(checkPayment).not.toHaveBeenCalled()
  })
})

describe('provisioning worker — registrations', () => {
  it('claims only its own side of the queue', async () => {
    const { instance, store } = worker(null, registrar({}))
    await expect(instance.tick()).resolves.toBe(false)
    expect(store.claimArgs[0]).toEqual(['test-worker', true, 300])
  })

  it('records a registration with what the registry has', async () => {
    const { instance, actions } = worker(job(), registrar({}))
    await expect(instance.tick()).resolves.toBe(true)
    expect(actions).toEqual([
      {
        type: 'complete',
        args: [
          'job-1',
          {
            domain: DOMAIN,
            recovered: false,
            nameserverResult: 'none',
            nameserverCode: null,
          } satisfies Completion,
        ],
      },
    ])
  })

  it('passes on what became of the checkout nameservers', async () => {
    const { instance, actions } = worker(
      job({ pendingNameservers: VERCEL }),
      registrar({ setNameservers: { kind: 'rejected', code: 'NAMESERVER_INVALID', message: 'x' } }),
    )
    await instance.tick()
    expect(actions[0]?.args[1]).toMatchObject({
      nameserverResult: 'rejected',
      nameserverCode: 'NAMESERVER_INVALID',
    })
  })

  it('keeps nameservers queued when the supplier blocked the change', async () => {
    const { instance, actions } = worker(
      job({ pendingNameservers: VERCEL }),
      registrar({
        setNameservers: { kind: 'blocked', code: 'SUPPLIER_AUTH', message: 'HTTP 401' },
        lookups: [{ kind: 'not_found' }, { kind: 'blocked', code: 'SUPPLIER_AUTH', message: '' }],
      }),
    )
    await instance.tick()
    expect(actions[0]?.args[1]).toMatchObject({ nameserverResult: 'unknown' })
  })

  it('fails a refused line for good', async () => {
    const { instance, actions } = worker(
      job(),
      registrar({ register: { kind: 'rejected', code: 'DOMAIN_TAKEN', message: 'Domain exists' } }),
    )
    await instance.tick()
    expect(actions).toEqual([
      { type: 'fail', args: ['job-1', 'DOMAIN_TAKEN', 'Domain exists', false] },
    ])
  })

  it('retries an unknown outcome later, with growing waits', async () => {
    const { instance, actions } = worker(job({ attempts: 2 }), registrar({ lookups: [timedOut] }))
    await instance.tick()
    expect(actions).toEqual([
      { type: 'reschedule', args: ['job-1', defaultBackoff(2), 'TIMEOUT', 'No answer'] },
    ])
    expect(defaultBackoff(1)).toBeLessThan(defaultBackoff(2))
  })

  it('hands an unknown outcome to a person once retries run out — never fails it (I2)', async () => {
    const { instance, actions } = worker(job({ attempts: 4 }), registrar({ lookups: [timedOut] }))
    await instance.tick()
    expect(actions).toEqual([{ type: 'fail', args: ['job-1', 'TIMEOUT', 'No answer', true] }])
  })

  it('retries a registration known not to have happened', async () => {
    const { instance, actions } = worker(
      job(),
      registrar({ lookups: [{ kind: 'not_found' }, { kind: 'not_found' }], register: timedOut }),
    )
    await instance.tick()
    expect(actions[0]?.type).toBe('reschedule')
  })

  it('fails it, for a refund, once retries run out', async () => {
    const { instance, actions } = worker(
      job({ attempts: 4 }),
      registrar({ lookups: [{ kind: 'not_found' }, { kind: 'not_found' }], register: timedOut }),
    )
    await instance.tick()
    expect(actions).toEqual([
      { type: 'fail', args: ['job-1', 'SUPPLIER_UNAVAILABLE', 'No answer', false] },
    ])
  })

  it('does not send a registration with a broken registrant', async () => {
    const register = vi.fn()
    const { instance, actions } = worker(job({ registrant: { firstName: 'Ada' } }), {
      ...registrar({}),
      register,
    })
    await instance.tick()
    expect(register).not.toHaveBeenCalled()
    expect(actions[0]).toMatchObject({
      type: 'fail',
      args: ['job-1', 'BAD_JOB', expect.any(String), true],
    })
  })

  it('leaves a crashed job for its lease to expire', async () => {
    const { instance, actions } = worker(job(), {
      ...registrar({}),
      lookup: async () => {
        throw new Error('database unavailable')
      },
    })
    await expect(instance.tick()).resolves.toBe(true)
    expect(actions).toEqual([])
  })
})

describe('provisioning worker — nameserver changes', () => {
  const change = (over: Partial<ClaimedJob> = {}) =>
    job({ kind: 'apply_nameservers', localStatus: 'active', pendingNameservers: VERCEL, ...over })

  it('records the applied set', async () => {
    const { instance, actions } = worker(change(), registrar({}))
    await instance.tick()
    expect(actions).toEqual([{ type: 'nameservers', args: ['job-1', VERCEL, VERCEL, null] }])
  })

  it('records a refusal against the set that was sent', async () => {
    const { instance, actions } = worker(
      change(),
      registrar({ setNameservers: { kind: 'rejected', code: 'NAMESERVER_INVALID', message: 'x' } }),
    )
    await instance.tick()
    expect(actions).toEqual([
      { type: 'nameservers', args: ['job-1', VERCEL, null, 'NAMESERVER_INVALID'] },
    ])
  })

  it('retries an unknown change', async () => {
    const { instance, actions } = worker(
      change(),
      registrar({ setNameservers: timedOut, lookups: [{ kind: 'found', domain: DOMAIN }] }),
    )
    await instance.tick()
    expect(actions[0]?.type).toBe('reschedule')
  })

  it('does nothing for a domain that is not active', async () => {
    const { instance, actions } = worker(change({ localStatus: 'pending' }), registrar({}))
    await instance.tick()
    expect(actions[0]).toMatchObject({
      type: 'fail',
      args: ['job-1', 'NOT_APPLICABLE', expect.any(String), false],
    })
  })
})

describe('the loop', () => {
  it('polls while idle and stops cleanly', async () => {
    const { instance, store } = worker(null, registrar({}), { pollMs: 5 })
    instance.start()
    await new Promise((resolve) => setTimeout(resolve, 30))
    await instance.stop()
    const polls = store.claimArgs.length
    expect(polls).toBeGreaterThan(1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(store.claimArgs.length).toBe(polls)
  })

  it('keeps going when a claim fails', async () => {
    const { instance, store } = worker(null, registrar({}), { pollMs: 5 })
    const claim = vi
      .spyOn(store, 'claim')
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue(null)
    instance.start()
    await new Promise((resolve) => setTimeout(resolve, 30))
    await instance.stop()
    expect(claim.mock.calls.length).toBeGreaterThan(1)
  })
})

describe('provisioning worker — renewals (FR-RN1)', () => {
  const renewal = (over: Partial<ClaimedJob> = {}) =>
    job({ kind: 'renew_domain', localStatus: 'active', periodYears: 2, ...over })
  const found = (expiresAt: string): Lookup => ({ kind: 'found', domain: { ...DOMAIN, expiresAt } })

  it('records the baseline before renewing, then the registry’s new expiry', async () => {
    const { instance, actions } = worker(
      renewal(),
      registrar({
        lookups: [found('2027-09-23T10:00:00.000Z'), found('2029-09-23T10:00:00.000Z')],
      }),
    )
    await instance.tick()
    expect(actions).toEqual([
      { type: 'baseline', args: ['job-1', '2027-09-23T10:00:00.000Z'] },
      { type: 'renewed', args: ['job-1', '2029-09-23T10:00:00.000Z', false] },
    ])
  })

  it('never renews for a charge Flutterwave does not confirm', async () => {
    const renew = vi.fn()
    const { instance, actions } = worker(
      renewal(),
      { ...registrar({}), renew },
      {
        checkPayment: async () => ({
          kind: 'refused',
          code: 'PAYMENT_NOT_VERIFIED',
          message: 'The charge is for another amount',
        }),
      },
    )
    await instance.tick()
    expect(renew).not.toHaveBeenCalled()
    expect(actions).toEqual([
      {
        type: 'fail',
        args: ['job-1', 'PAYMENT_NOT_VERIFIED', 'The charge is for another amount', true],
      },
    ])
  })

  it('finishes without renewing again when an earlier attempt already landed', async () => {
    const renew = vi.fn()
    const { instance, actions } = worker(renewal({ baselineExpiry: '2027-09-23T10:00:00.000Z' }), {
      ...registrar({ lookups: [found('2029-09-23T10:00:00.000Z')] }),
      renew,
    })
    await instance.tick()
    expect(renew).not.toHaveBeenCalled()
    expect(actions).toEqual([
      { type: 'renewed', args: ['job-1', '2029-09-23T10:00:00.000Z', true] },
    ])
  })

  it('refunds a refusal: the line fails, not for a person', async () => {
    const { instance, actions } = worker(
      renewal(),
      registrar({
        lookups: [found('2027-09-23T10:00:00.000Z')],
        renew: { kind: 'rejected', code: 'DOMAIN_NOT_FOUND', message: 'Cannot renew' },
      }),
    )
    await instance.tick()
    expect(actions.at(-1)).toEqual({
      type: 'fail',
      args: ['job-1', 'DOMAIN_NOT_FOUND', 'Cannot renew', false],
    })
  })

  it('waits on an unknown answer, and never renews again blind (I2)', async () => {
    const { instance, actions } = worker(
      renewal(),
      registrar({
        lookups: [found('2027-09-23T10:00:00.000Z'), timedOut],
        renew: timedOut,
      }),
    )
    await instance.tick()
    expect(actions.at(-1)).toEqual({
      type: 'reschedule',
      args: ['job-1', 30, 'TIMEOUT', 'No answer'],
    })
  })

  it('holds for a person once retries of an unknown answer run out', async () => {
    const { instance, actions } = worker(
      renewal({ attempts: 4, baselineExpiry: '2027-09-23T10:00:00.000Z' }),
      registrar({ lookups: [found('2028-03-23T10:00:00.000Z')] }),
    )
    await instance.tick()
    expect(actions.at(-1)).toEqual({
      type: 'fail',
      args: ['job-1', 'EXPIRY_MOVED', expect.any(String), true],
    })
  })

  it('tries again when a failed attempt is known not to have renewed, then fails for a refund', async () => {
    const script = {
      lookups: [found('2027-09-23T10:00:00.000Z'), found('2027-09-23T10:00:00.000Z')],
      renew: timedOut,
    }
    const first = worker(renewal(), registrar(script))
    await first.instance.tick()
    expect(first.actions.at(-1)).toEqual({
      type: 'reschedule',
      args: ['job-1', 30, 'TIMEOUT', 'No answer'],
    })

    const last = worker(
      renewal({ attempts: 4 }),
      registrar({ ...script, lookups: [...script.lookups] }),
    )
    await last.instance.tick()
    expect(last.actions.at(-1)).toEqual({
      type: 'fail',
      args: ['job-1', 'SUPPLIER_UNAVAILABLE', 'No answer', false],
    })
  })

  it('holds a renewal with no period for a person', async () => {
    const { instance, actions } = worker(renewal({ periodYears: null }), registrar({}))
    await instance.tick()
    expect(actions).toEqual([
      { type: 'fail', args: ['job-1', 'BAD_JOB', 'Renewal period missing', true] },
    ])
  })

  it('holds a job of a kind it does not know, rather than failing it as something else', async () => {
    const { instance, actions } = worker(
      job({ kind: 'transfer_domain' as ClaimedJob['kind'] }),
      registrar({}),
    )
    await instance.tick()
    expect(actions).toEqual([
      {
        type: 'fail',
        args: ['job-1', 'UNKNOWN_JOB_KIND', 'No handler for transfer_domain', true],
      },
    ])
  })
})

describe('provisioning worker — registry-side settings (FR-DS1, FR-DS3, FR-DS4)', () => {
  const setting = (over: Partial<ClaimedJob> = {}) =>
    job({
      kind: 'set_transfer_lock',
      localStatus: 'active',
      source: 'registration',
      pendingTransferLock: false,
      payment: null,
      ...over,
    })

  /** A registry for settings that answers reads in order and records writes. */
  function settingsRegistry(
    script: {
      lookups?: Lookup[]
      contacts?: Reading<RegistryContacts>[]
      write?: SettingWrite
    } = {},
  ) {
    const lookups = [...(script.lookups ?? [])]
    const contacts = [...(script.contacts ?? [])]
    const writes: unknown[][] = []
    const write = async (...args: unknown[]) => {
      writes.push(args)
      return script.write ?? ({ kind: 'ok' } as const)
    }
    const registrar: SettingsRegistrar = {
      lookup: async () => lookups.shift() ?? { kind: 'not_found' },
      contacts: async () => contacts.shift() ?? { kind: 'not_found' },
      setTransferLock: write,
      setPrivacy: write,
      updateContacts: write,
    }
    return { registrar, writes }
  }

  const locked = (transferLock: boolean, privacy = false): Lookup => ({
    kind: 'found',
    domain: { ...DOMAIN, transferLock, privacy },
  })

  function run(claimed: ClaimedJob, settings: SettingsRegistrar) {
    return worker(claimed, registrar({}), { settingsFor: () => settings })
  }

  it('turns the lock off, reads it back, and records what the registry holds', async () => {
    const { registrar: reg, writes } = settingsRegistry({ lookups: [locked(true), locked(false)] })
    const { instance, actions } = run(setting(), reg)
    await instance.tick()
    expect(writes).toEqual([['example.com', false]])
    expect(actions).toEqual([
      {
        type: 'setting',
        args: ['job-1', { transfer_lock: false }, { transfer_lock: false }, null],
      },
    ])
  })

  it('records it applied without writing when the registry already holds it (I1)', async () => {
    const { registrar: reg, writes } = settingsRegistry({ lookups: [locked(false)] })
    const { instance, actions } = run(setting(), reg)
    await instance.tick()
    expect(writes).toEqual([])
    expect(actions.at(-1)?.type).toBe('setting')
  })

  it('records a refusal with its code', async () => {
    const { registrar: reg } = settingsRegistry({
      lookups: [locked(true, false)],
      write: { kind: 'rejected', code: 'REGISTRY_REFUSED', message: 'Not allowed' },
    })
    const { instance, actions } = run(
      setting({ kind: 'set_privacy', pendingTransferLock: null, pendingPrivacy: true }),
      reg,
    )
    await instance.tick()
    expect(actions).toEqual([
      { type: 'setting', args: ['job-1', { privacy: true }, null, 'REGISTRY_REFUSED'] },
    ])
  })

  it('turns privacy on and records it', async () => {
    const { registrar: reg } = settingsRegistry({
      lookups: [locked(true, false), locked(true, true)],
    })
    const { instance, actions } = run(
      setting({ kind: 'set_privacy', pendingTransferLock: null, pendingPrivacy: true }),
      reg,
    )
    await instance.tick()
    expect(actions).toEqual([
      { type: 'setting', args: ['job-1', { privacy: true }, { privacy: true }, null] },
    ])
  })

  it('saves new contacts and records exactly what was asked, once the registry shows it', async () => {
    const next = { ...REGISTRANT, firstName: 'Bayo', email: 'bayo@example.com' }
    const all = (contact: typeof REGISTRANT) => {
      const held = asRegistryContact(contact)
      return {
        kind: 'found',
        data: { registrant: held, administrative: held, technical: held, billing: held },
      } as const
    }
    const { registrar: reg, writes } = settingsRegistry({
      contacts: [all(REGISTRANT), all(next)],
    })
    const { instance, actions } = run(
      setting({ kind: 'update_contacts', pendingTransferLock: null, pendingRegistrant: next }),
      reg,
    )
    await instance.tick()
    expect(writes).toEqual([['example.com', next]])
    expect(actions).toEqual([
      { type: 'setting', args: ['job-1', { registrant: next }, { registrant: next }, null] },
    ])
  })

  it('holds invalid requested contacts for a person, and sends nothing', async () => {
    const { registrar: reg, writes } = settingsRegistry()
    const { instance, actions } = run(
      setting({
        kind: 'update_contacts',
        pendingTransferLock: null,
        pendingRegistrant: { firstName: 'Bayo' },
      }),
      reg,
    )
    await instance.tick()
    expect(writes).toEqual([])
    expect(actions).toEqual([
      { type: 'fail', args: ['job-1', 'BAD_JOB', 'Requested registrant is invalid', true] },
    ])
  })

  it.each([
    ['a demo domain', { source: 'demo' }],
    ['a domain that is not active', { localStatus: 'pending' }],
    ['nothing waiting to be applied', { pendingTransferLock: null }],
  ])('sends nothing for %s', async (_case, over) => {
    const { registrar: reg, writes } = settingsRegistry({ lookups: [locked(true)] })
    const { instance, actions } = run(setting(over as Partial<ClaimedJob>), reg)
    await instance.tick()
    expect(writes).toEqual([])
    expect(actions).toEqual([
      { type: 'fail', args: ['job-1', 'NOT_APPLICABLE', expect.any(String), false] },
    ])
  })

  it('waits on a timeout the read cannot settle, and never writes again blind (I2)', async () => {
    const { registrar: reg } = settingsRegistry({
      lookups: [locked(true), timedOut],
      write: timedOut,
    })
    const { instance, actions } = run(setting(), reg)
    await instance.tick()
    expect(actions).toEqual([{ type: 'reschedule', args: ['job-1', 30, 'TIMEOUT', 'No answer'] }])
  })

  it('holds for a person once retries of an unknown answer run out', async () => {
    const { registrar: reg } = settingsRegistry({ lookups: [timedOut] })
    const { instance, actions } = run(setting({ attempts: 4 }), reg)
    await instance.tick()
    expect(actions).toEqual([{ type: 'fail', args: ['job-1', 'TIMEOUT', 'No answer', true] }])
  })

  it('tries again when an unclear write is known not to have landed, then gives up', async () => {
    const script = { lookups: [locked(true), locked(true)], write: timedOut }
    const first = run(setting(), settingsRegistry(script).registrar)
    await first.instance.tick()
    expect(first.actions).toEqual([
      { type: 'reschedule', args: ['job-1', 30, 'TIMEOUT', 'No answer'] },
    ])

    const last = run(setting({ attempts: 4 }), settingsRegistry(script).registrar)
    await last.instance.tick()
    expect(last.actions).toEqual([
      { type: 'fail', args: ['job-1', 'SUPPLIER_UNAVAILABLE', 'No answer', false] },
    ])
  })

  it('treats refused credentials like any unsettled answer', async () => {
    const { registrar: reg } = settingsRegistry({
      lookups: [{ kind: 'blocked', code: 'SUPPLIER_AUTH', message: 'HTTP 401' }],
    })
    const { instance, actions } = run(setting(), reg)
    await instance.tick()
    expect(actions).toEqual([
      { type: 'reschedule', args: ['job-1', 30, 'SUPPLIER_AUTH', 'HTTP 401'] },
    ])
  })

  it('holds a settings job for a person when this build has no settings registrar', async () => {
    const { instance, actions } = worker(setting(), registrar({}))
    await instance.tick()
    expect(actions).toEqual([
      {
        type: 'fail',
        args: ['job-1', 'UNKNOWN_JOB_KIND', 'No handler for set_transfer_lock', true],
      },
    ])
  })
})
