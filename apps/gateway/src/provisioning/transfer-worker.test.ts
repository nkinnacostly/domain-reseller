import { describe, expect, it, vi } from 'vitest'
import type {
  Lookup,
  Registrar,
  RegistryDomain,
  TransferCheckAnswer,
  TransferRegistrar,
  TransferWrite,
} from './registrar'
import type { ClaimedJob, JobStore, TransferRecorded } from './store'
import { createWorker, TRANSFER_POLL_SECONDS, TRANSFER_SLOW_POLL_SECONDS } from './worker'

/**
 * The worker's transfer-in path (PRD E9, migration 26): the charge first, the
 * code only before submission, and polling that no attempts cap ends.
 */

const NOW = new Date('2026-09-24T12:00:00.000Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR
const CODE = 'S3cret-Tr4nsfer-Code'

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

const ACTIVE: RegistryDomain = {
  registeredAt: '2019-03-01T10:00:00.000Z',
  expiresAt: '2027-03-01T10:00:00.000Z',
  nameservers: ['ns1.example-host.com', 'ns2.example-host.com'],
  transferLock: true,
  privacy: false,
  status: 'Active',
}
const found = (domain: RegistryDomain): Lookup => ({ kind: 'found', domain })
const WAITING = found({ ...ACTIVE, status: 'WaitingForIncomingTransfer' })

const job = (over: Partial<ClaimedJob> = {}): ClaimedJob => ({
  id: 'job-1',
  kind: 'transfer_domain',
  attempts: 1,
  testMode: true,
  domainId: 'domain-1',
  domainName: 'getpaid.com',
  localStatus: 'transfer_requested',
  privacy: false,
  registrant: REGISTRANT,
  pendingNameservers: null,
  periodYears: 1,
  expiresAt: null,
  baselineExpiry: null,
  payment: {
    orderTxRef: 'MDH-2f1c1a3e-8d7b-4c55-9a0e-1f2d3c4b5a69',
    orderTotalKobo: 4_200_000,
    reference: '4242',
    amountKobo: 4_200_000,
    currency: 'NGN',
    status: 'successful',
  },
  authCode: CODE,
  submittedAt: null,
  ...over,
})
const submitted = (hoursAgo: number, over: Partial<ClaimedJob> = {}) =>
  job({
    localStatus: 'transfer_pending',
    authCode: null,
    submittedAt: new Date(NOW.getTime() - hoursAgo * HOUR).toISOString(),
    ...over,
  })

function fakeStore(claimed: ClaimedJob, recorded: TransferRecorded = 'recorded') {
  let next: ClaimedJob | null = claimed
  const actions: { type: string; args: unknown[] }[] = []
  const record =
    (type: string) =>
    async (...args: unknown[]) => {
      actions.push({ type, args })
    }
  const store: JobStore = {
    async claim() {
      const taken = next
      next = null
      return taken
    },
    recordCall: record('recordCall'),
    completeRegistration: record('complete') as JobStore['completeRegistration'],
    noteRenewalBaseline: async (_id, expiresAt) => expiresAt,
    completeRenewal: record('renewed') as JobStore['completeRenewal'],
    markTransferSubmitted: record('submitted') as JobStore['markTransferSubmitted'],
    recordDomainChange: record('setting') as JobStore['recordDomainChange'],
    completeTransfer: async (...args) => {
      actions.push({ type: 'transferred', args })
      return recorded
    },
    recordNameserverChange: record('nameservers') as JobStore['recordNameserverChange'],
    reschedule: record('reschedule') as JobStore['reschedule'],
    fail: record('fail') as JobStore['fail'],
  }
  return { store, actions }
}

function transfers(script: {
  lookups?: Lookup[]
  check?: TransferCheckAnswer
  transfer?: TransferWrite
}) {
  const lookups = [...(script.lookups ?? [])]
  return {
    lookup: vi.fn(async (): Promise<Lookup> => lookups.shift() ?? { kind: 'not_found' }),
    checkTransfer: vi.fn(
      async (): Promise<TransferCheckAnswer> =>
        script.check ?? { kind: 'ok', data: { transferable: true } },
    ),
    transfer: vi.fn(async (): Promise<TransferWrite> => script.transfer ?? { kind: 'ok' }),
  } satisfies TransferRegistrar
}

/** Registrations, renewals and nameservers are not this file's business. */
const noRegistrar = (): Registrar => {
  throw new Error('a transfer used the registration registrar')
}

function worker(
  claimed: ClaimedJob,
  reg: TransferRegistrar | null,
  over: Partial<Parameters<typeof createWorker>[0]> = {},
  recorded: TransferRecorded = 'recorded',
) {
  const { store, actions } = fakeStore(claimed, recorded)
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const instance = createWorker({
    store,
    registrarFor: noRegistrar,
    ...(reg ? { transfersFor: () => reg } : {}),
    checkPayment: async () => ({ kind: 'verified' }),
    testMode: true,
    workerId: 'test-worker',
    pollMs: 10,
    log,
    now: () => NOW,
    ...over,
  })
  return { instance, actions, log }
}

const timedOut = { kind: 'unknown', code: 'TIMEOUT', message: 'No answer' } as const

describe('transfer worker — the charge comes first (SEC-7)', () => {
  it('never touches the registry for a charge Flutterwave does not confirm — and never refunds it', async () => {
    const reg = transfers({})
    const { instance, actions } = worker(job(), reg, {
      checkPayment: async () => ({
        kind: 'refused',
        code: 'PAYMENT_NOT_VERIFIED',
        message: 'Not our charge',
      }),
    })
    await instance.tick()
    expect(actions).toEqual([
      { type: 'fail', args: ['job-1', 'PAYMENT_NOT_VERIFIED', 'Not our charge', true] },
    ])
    expect(reg.lookup).not.toHaveBeenCalled()
  })

  it('waits when Flutterwave cannot be asked', async () => {
    const reg = transfers({})
    const { instance, actions } = worker(job(), reg, {
      checkPayment: async () => ({ kind: 'unknown', code: 'FLW_NO_ANSWER', message: 'timeout' }),
    })
    await instance.tick()
    expect(actions).toEqual([
      { type: 'reschedule', args: ['job-1', 30, 'FLW_NO_ANSWER', 'timeout'] },
    ])
    expect(reg.lookup).not.toHaveBeenCalled()
  })

  it('does not ask Flutterwave again while polling: the money is already spent', async () => {
    const checkPayment = vi.fn()
    const { instance } = worker(submitted(2), transfers({ lookups: [WAITING] }), {
      checkPayment,
    })
    await instance.tick()
    expect(checkPayment).not.toHaveBeenCalled()
  })
})

describe('transfer worker — sending the request', () => {
  it('fails a refused code for a refund, never sending the transfer', async () => {
    const reg = transfers({
      check: { kind: 'ok', data: { transferable: false, reason: 'AUTH_CODE_INVALID' } },
    })
    const { instance, actions } = worker(job(), reg)
    await instance.tick()
    expect(actions).toEqual([
      { type: 'fail', args: ['job-1', 'AUTH_CODE_INVALID', expect.any(String), false] },
    ])
    expect(reg.transfer).not.toHaveBeenCalled()
  })

  it('fails a line whose code was lost, for a refund', async () => {
    const { instance, actions } = worker(job({ authCode: null }), transfers({}))
    await instance.tick()
    expect(actions).toEqual([
      { type: 'fail', args: ['job-1', 'AUTH_CODE_MISSING', expect.any(String), false] },
    ])
  })

  it('marks it submitted once the registry takes it, polling in 15 minutes (§13.5)', async () => {
    const reg = transfers({})
    const { instance, actions } = worker(job(), reg)
    await instance.tick()
    expect(actions).toEqual([{ type: 'submitted', args: ['job-1', TRANSFER_POLL_SECONDS] }])
    expect(reg.transfer).toHaveBeenCalledWith(
      expect.objectContaining({ authCode: CODE, periodYears: 1, contact: REGISTRANT }),
    )
  })

  it('finishes a transfer an earlier attempt already landed', async () => {
    const { instance, actions } = worker(job(), transfers({ lookups: [found(ACTIVE)] }))
    await instance.tick()
    expect(actions).toEqual([{ type: 'transferred', args: ['job-1', ACTIVE, true] }])
  })

  it('refunds rather than records a transfer when the name is held here already', async () => {
    const { instance, actions } = worker(
      job(),
      transfers({ lookups: [found(ACTIVE)] }),
      {},
      'held_elsewhere',
    )
    await instance.tick()
    expect(actions.at(-1)).toEqual({
      type: 'fail',
      args: ['job-1', 'ALREADY_HERE', expect.any(String), false],
    })
  })

  it('fails a transfer the registry refuses', async () => {
    const { instance, actions } = worker(
      job(),
      transfers({ transfer: { kind: 'rejected', code: 'TRANSFER_LOCKED', message: 'Locked' } }),
    )
    await instance.tick()
    expect(actions).toEqual([{ type: 'fail', args: ['job-1', 'TRANSFER_LOCKED', 'Locked', false] }])
  })

  it('sends again later when a lost answer is known not to have landed, then refunds', async () => {
    const script = { lookups: [{ kind: 'not_found' }, { kind: 'not_found' }], transfer: timedOut }
    const early = worker(job({ attempts: 1 }), transfers(script as never))
    await early.instance.tick()
    expect(early.actions).toEqual([
      { type: 'reschedule', args: ['job-1', 30, 'TIMEOUT', 'No answer'] },
    ])

    const spent = worker(job({ attempts: 4 }), transfers(script as never))
    await spent.instance.tick()
    expect(spent.actions).toEqual([
      { type: 'fail', args: ['job-1', 'SUPPLIER_UNAVAILABLE', 'No answer', false] },
    ])
  })

  it('holds an unknown outcome for a person once retries are spent — never refunds it (I2)', async () => {
    const script = { lookups: [{ kind: 'not_found' }, timedOut], transfer: timedOut }
    const early = worker(job({ attempts: 2 }), transfers(script as never))
    await early.instance.tick()
    expect(early.actions).toEqual([
      { type: 'reschedule', args: ['job-1', 120, 'TIMEOUT', 'No answer'] },
    ])

    const spent = worker(job({ attempts: 4 }), transfers(script as never))
    await spent.instance.tick()
    expect(spent.actions).toEqual([{ type: 'fail', args: ['job-1', 'TIMEOUT', 'No answer', true] }])
  })

  it('reports refused credentials and waits', async () => {
    const { instance, actions, log } = worker(
      job(),
      transfers({ lookups: [{ kind: 'blocked', code: 'SUPPLIER_AUTH', message: 'HTTP 401' }] }),
    )
    await instance.tick()
    expect(actions).toEqual([
      { type: 'reschedule', args: ['job-1', 30, 'SUPPLIER_AUTH', 'HTTP 401'] },
    ])
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SUPPLIER_AUTH' }),
      'supplier refused our credentials',
    )
  })

  it('holds a job with a broken registrant for a person, touching nothing', async () => {
    const reg = transfers({})
    const { instance, actions } = worker(job({ registrant: { firstName: 'Ada' } }), reg)
    await instance.tick()
    expect(actions).toEqual([
      { type: 'fail', args: ['job-1', 'BAD_JOB', expect.any(String), true] },
    ])
    expect(reg.lookup).not.toHaveBeenCalled()
  })

  it('holds a transfer for a person when this gateway cannot work transfers', async () => {
    const { instance, actions } = worker(job(), null)
    await instance.tick()
    expect(actions).toEqual([
      { type: 'fail', args: ['job-1', 'TRANSFERS_OFF', expect.any(String), true] },
    ])
  })

  it('never puts the transfer code in a log line (N13)', async () => {
    for (const script of [
      {},
      { check: { kind: 'ok', data: { transferable: false, reason: 'AUTH_CODE_INVALID' } } },
      { transfer: { kind: 'rejected', code: 'AUTH_CODE_INVALID', message: 'Bad code' } },
      { lookups: [{ kind: 'not_found' }, timedOut], transfer: timedOut },
    ]) {
      const { instance, log } = worker(job(), transfers(script as never))
      await instance.tick()
      const logged = JSON.stringify([
        log.info.mock.calls,
        log.warn.mock.calls,
        log.error.mock.calls,
      ])
      expect(logged).not.toContain(CODE)
    }
  })
})

describe('transfer worker — polling until it lands (FR-T3)', () => {
  it('records the transfer when the registry shows it active', async () => {
    const { instance, actions } = worker(submitted(3), transfers({ lookups: [found(ACTIVE)] }))
    await instance.tick()
    expect(actions).toEqual([{ type: 'transferred', args: ['job-1', ACTIVE, false] }])
  })

  it('polls every 15 minutes on the first day, then hourly — however many claims it takes', async () => {
    const young = worker(submitted(3, { attempts: 40 }), transfers({ lookups: [WAITING] }))
    await young.instance.tick()
    expect(young.actions).toEqual([
      {
        type: 'reschedule',
        args: ['job-1', TRANSFER_POLL_SECONDS, 'TRANSFER_PENDING', expect.any(String)],
      },
    ])

    const old = worker(submitted(30, { attempts: 400 }), transfers({ lookups: [WAITING] }))
    await old.instance.tick()
    expect(old.actions).toEqual([
      {
        type: 'reschedule',
        args: ['job-1', TRANSFER_SLOW_POLL_SECONDS, 'TRANSFER_PENDING', expect.any(String)],
      },
    ])
  })

  it('keeps polling through reads that fail, rather than giving up at the attempts cap', async () => {
    const { instance, actions } = worker(
      submitted(5, { attempts: 9 }),
      transfers({ lookups: [timedOut] }),
    )
    await instance.tick()
    expect(actions).toEqual([
      { type: 'reschedule', args: ['job-1', TRANSFER_POLL_SECONDS, 'TIMEOUT', 'No answer'] },
    ])
  })

  it('fails a transfer the registry shows refused, for a refund', async () => {
    const { instance, actions } = worker(
      submitted(6),
      transfers({ lookups: [found({ ...ACTIVE, status: 'TransferCancelled' })] }),
    )
    await instance.tick()
    expect(actions).toEqual([
      { type: 'fail', args: ['job-1', 'TRANSFER_REJECTED', expect.any(String), false] },
    ])
  })

  it('hands a transfer undecided after ten days to a person — never a refund', async () => {
    const { instance, actions } = worker(submitted(10 * 24), transfers({ lookups: [WAITING] }))
    await instance.tick()
    expect(actions).toEqual([
      { type: 'fail', args: ['job-1', 'TRANSFER_OVERDUE', expect.any(String), true] },
    ])
  })

  it('polls without a registrant: only the request needed one', async () => {
    const { instance, actions } = worker(
      submitted(1, { registrant: null }),
      transfers({ lookups: [WAITING] }),
    )
    await instance.tick()
    expect(actions[0]?.type).toBe('reschedule')
  })

  it('treats a day of the registry not listing it as a refusal', async () => {
    const { instance, actions } = worker(submitted(DAY / HOUR + 1), transfers({}))
    await instance.tick()
    expect(actions).toEqual([
      { type: 'fail', args: ['job-1', 'TRANSFER_REJECTED', expect.any(String), false] },
    ])
  })
})
