import { describe, expect, it, vi } from 'vitest'
import type { Lookup, Registrar, RegistryDomain, Write } from './registrar'
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
    recordNameserverChange: record('nameservers') as JobStore['recordNameserverChange'],
    reschedule: record('reschedule') as JobStore['reschedule'],
    fail: record('fail') as JobStore['fail'],
  }
  return { store, actions }
}

function registrar(script: {
  lookups?: Lookup[]
  register?: Write<RegistryDomain>
  setNameservers?: Write<string[]>
}): Registrar {
  const lookups = [...(script.lookups ?? [])]
  return {
    lookup: async () => lookups.shift() ?? { kind: 'not_found' },
    register: async () => script.register ?? { kind: 'ok', data: DOMAIN },
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
