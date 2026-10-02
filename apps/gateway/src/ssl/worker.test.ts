import { describe, expect, it, vi } from 'vitest'
import type { PaymentCheck } from '../payments/charge-check'
import type { SslClient } from './client'
import type { ClaimedSslJob, SslStore } from './store'
import { createSslWorker } from './worker'

/**
 * The SSL worker (migration 39): what each outcome does to the job, and that
 * nothing is bought for a charge Flutterwave does not confirm (SEC-7).
 */

const PEM_KEY = '-----BEGIN PRIVATE KEY-----\nMIIEsecret\n-----END PRIVATE KEY-----'

const CONTACT = {
  firstName: 'Ada',
  lastName: 'Okafor',
  email: 'ada@example.com',
  phoneCountryCode: '234',
  phone: '8031234567',
  addressLine1: '12 Admiralty Way',
  city: 'Lagos',
  state: 'Lagos',
  zipCode: '100001',
  country: 'NG',
}

function job(over: Partial<ClaimedSslJob> = {}): ClaimedSslJob {
  return {
    id: 'job-1',
    kind: 'ssl_initialize',
    attempts: 1,
    testMode: true,
    sentAt: null,
    certificateId: 'cert-1',
    commonName: 'example.com',
    productCode: '351',
    isWildcard: false,
    includedNames: 1,
    status: 'pending',
    csr: null,
    approverEmail: null,
    webServer: null,
    sanNames: [],
    contact: null,
    nameTaken: false,
    payment: {
      orderTxRef: 'MDH-1',
      orderTotalKobo: 1451250,
      reference: '900001',
      amountKobo: 1451250,
      currency: 'NGN',
      status: 'successful',
    },
    ...over,
  }
}

type FakeStore = { [K in keyof SslStore]: ReturnType<typeof vi.fn> }

function fakeStore(claimed: ClaimedSslJob | null): FakeStore {
  return {
    claim: vi.fn(async () => claimed),
    recordCall: vi.fn(async () => {}),
    noteSent: vi.fn(async () => '2026-10-02T12:00:00Z'),
    completeInitialize: vi.fn(async () => 'recorded' as const),
    recordConfigured: vi.fn(async () => {}),
    refuseSetup: vi.fn(async () => {}),
    recordReissue: vi.fn(async () => {}),
    reschedule: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
    toCheck: vi.fn(async () => []),
    recordStatus: vi.fn(async () => {}),
  }
}

const found = (word: string) => ({
  kind: 'found' as const,
  data: {
    domainName: 'example.com',
    status: word,
    isConfigured: word !== 'WaitingForInstall',
    isIssued: word === 'Active',
    certificateExpiresAt: null,
  },
})

function client(over: Partial<Record<keyof SslClient, unknown>> = {}): SslClient {
  const fn = (value: unknown) => vi.fn(async () => value)
  return {
    status: fn({ kind: 'not_found' }),
    details: fn({ kind: 'not_found' }),
    content: fn({ kind: 'not_found' }),
    approvers: fn({ kind: 'found', data: [] }),
    checkCsr: fn({ kind: 'not_found' }),
    generateCsr: fn({ kind: 'not_found' }),
    initialize: fn({ kind: 'ok', data: { certificateId: null, status: 'WaitingForInstall' } }),
    configure: fn({ kind: 'ok', data: { status: 'WaitingForValidation' } }),
    reissue: fn({ kind: 'ok', data: { status: 'WaitingForValidation' } }),
    ...Object.fromEntries(
      Object.entries(over).map(([key, value]) => [key, vi.fn(async () => value)]),
    ),
  } as SslClient
}

function worker(store: FakeStore, ssl: SslClient, paid: PaymentCheck = { kind: 'verified' }) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const checkPayment = vi.fn(async () => paid)
  const w = createSslWorker({
    store: store as unknown as SslStore,
    clientFor: () => ssl,
    checkPayment,
    testMode: true,
    workerId: 'test',
    pollMs: 10,
    log,
    maxAttempts: 2,
  })
  return { w, log, checkPayment }
}

describe('the SSL worker: ordering', () => {
  it('buys only after the charge is confirmed, and records the purchase', async () => {
    const store = fakeStore(job())
    const ssl = client()
    const { w, checkPayment } = worker(store, ssl)
    await expect(w.tick()).resolves.toBe(true)
    expect(checkPayment).toHaveBeenCalledTimes(1)
    expect(ssl.initialize).toHaveBeenCalledWith('351', 'example.com')
    expect(store.noteSent).toHaveBeenCalledWith('job-1')
    expect(store.completeInitialize).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ supplierStatus: 'WaitingForInstall' }),
      false,
    )
  })

  it('buys nothing for a charge Flutterwave refuses, and holds it for a person — no refund', async () => {
    const store = fakeStore(job())
    const ssl = client()
    const { w } = worker(store, ssl, {
      kind: 'refused',
      code: 'PAYMENT_NOT_VERIFIED',
      message: 'No charge',
    })
    await w.tick()
    expect(ssl.initialize).not.toHaveBeenCalled()
    expect(store.fail).toHaveBeenCalledWith('job-1', 'PAYMENT_NOT_VERIFIED', 'No charge', true)
  })

  it('asks again later when Flutterwave cannot be asked', async () => {
    const store = fakeStore(job())
    const { w } = worker(store, client(), { kind: 'unknown', code: 'TIMEOUT', message: 'slow' })
    await w.tick()
    expect(store.reschedule).toHaveBeenCalledWith('job-1', 30, 'TIMEOUT', 'slow')
  })

  it('does not ask Flutterwave again once a purchase may have been sent', async () => {
    const store = fakeStore(job({ sentAt: '2026-10-02T12:00:00Z' }))
    const ssl = client({ status: found('WaitingForInstall') })
    const { w, checkPayment } = worker(store, ssl)
    await w.tick()
    expect(checkPayment).not.toHaveBeenCalled()
    expect(ssl.initialize).not.toHaveBeenCalled()
    expect(store.completeInitialize).toHaveBeenCalledWith('job-1', expect.anything(), true)
  })

  it('fails a refused order for a refund — nothing was bought', async () => {
    const store = fakeStore(job())
    const ssl = client({ initialize: { kind: 'rejected', code: 'SSL_REFUSED', message: 'No' } })
    const { w } = worker(store, ssl)
    await w.tick()
    expect(store.fail).toHaveBeenCalledWith('job-1', 'SSL_REFUSED', 'No', false)
  })

  it('fails a name another certificate holds for a refund, before buying', async () => {
    const store = fakeStore(job({ nameTaken: true }))
    const ssl = client()
    const { w } = worker(store, ssl)
    await w.tick()
    expect(ssl.initialize).not.toHaveBeenCalled()
    expect(store.fail).toHaveBeenCalledWith(
      'job-1',
      'NAME_HAS_CERTIFICATE',
      expect.any(String),
      false,
    )
  })

  it('reschedules an unknown outcome, then holds it for a person — never refunds it (I2)', async () => {
    const timeout = { kind: 'unknown', code: 'TIMEOUT', message: 'No answer' }
    const first = fakeStore(job())
    await worker(first, client({ initialize: timeout })).w.tick()
    expect(first.reschedule).toHaveBeenCalledWith('job-1', 30, 'TIMEOUT', 'No answer')

    const last = fakeStore(job({ attempts: 2, sentAt: 'x' }))
    await worker(last, client()).w.tick()
    expect(last.fail).toHaveBeenCalledWith('job-1', 'NOT_YET_VISIBLE', expect.any(String), true)
  })

  it('holds a purchase it could not record beside another certificate for the name', async () => {
    const store = fakeStore(job())
    store.completeInitialize.mockResolvedValueOnce('name_held_here')
    const { w } = worker(store, client())
    await w.tick()
    expect(store.fail).toHaveBeenCalledWith('job-1', 'NAME_HELD_HERE', expect.any(String), true)
  })
})

describe('the SSL worker: set-up and reissue', () => {
  const setUp = job({
    kind: 'ssl_configure',
    csr: '-----BEGIN CERTIFICATE REQUEST-----\nMIIC\n-----END CERTIFICATE REQUEST-----',
    approverEmail: 'admin@example.com',
    webServer: 'apache',
    contact: CONTACT,
    payment: null,
  })

  it('sends the set-up with the contact in the supplier’s shape, and records it', async () => {
    const store = fakeStore(setUp)
    const ssl = client({ status: found('WaitingForInstall') })
    await worker(store, ssl).w.tick()
    expect(ssl.configure).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'example.com',
        webServer: 'apache',
        contact: expect.objectContaining({
          phone: '+2348031234567',
          fax: '+2348031234567',
          phoneCountryCode: 'NG',
        }),
      }),
    )
    expect(store.recordConfigured).toHaveBeenCalledWith('job-1', 'WaitingForValidation', false)
  })

  it('gives a refused set-up back to the customer', async () => {
    const store = fakeStore(setUp)
    const ssl = client({
      status: found('WaitingForInstall'),
      configure: { kind: 'rejected', code: 'APPROVER_INVALID', message: 'Invalid email address' },
    })
    await worker(store, ssl).w.tick()
    expect(store.refuseSetup).toHaveBeenCalledWith(
      'job-1',
      'APPROVER_INVALID',
      'Invalid email address',
    )
  })

  it('holds a set-up with missing or bad data for a person, sending nothing', async () => {
    for (const bad of [{ csr: null }, { webServer: 'nginx' }, { contact: { firstName: 'x' } }]) {
      const store = fakeStore({ ...setUp, ...bad })
      const ssl = client()
      await worker(store, ssl).w.tick()
      expect(ssl.configure).not.toHaveBeenCalled()
      expect(store.fail).toHaveBeenCalledWith('job-1', 'BAD_JOB', expect.any(String), true)
    }
  })

  it('reissues, and records where the certificate now stands', async () => {
    const store = fakeStore(
      job({
        kind: 'ssl_reissue',
        status: 'reissuing',
        approverEmail: 'admin@example.com',
        payment: null,
      }),
    )
    const statuses = [found('Active'), found('WaitingForValidation')]
    const ssl = client()
    ssl.status = vi.fn(async () => statuses.shift() as never)
    await worker(store, ssl).w.tick()
    expect(ssl.reissue).toHaveBeenCalledWith('example.com', 'admin@example.com')
    expect(store.recordReissue).toHaveBeenCalledWith(
      'job-1',
      'WaitingForValidation',
      'awaiting_validation',
      false,
    )
  })

  it('fails a refused reissue back to the issued certificate', async () => {
    const store = fakeStore(job({ kind: 'ssl_reissue', payment: null }))
    const ssl = client({
      status: found('Active'),
      reissue: { kind: 'rejected', code: 'NOT_SUPPORTED', message: 'Package is not supported' },
    })
    await worker(store, ssl).w.tick()
    expect(store.fail).toHaveBeenCalledWith(
      'job-1',
      'NOT_SUPPORTED',
      'Package is not supported',
      false,
    )
  })

  it('holds a kind it does not know, and runs nothing (deploy order)', async () => {
    const store = fakeStore(job({ kind: 'ssl_revoke' }))
    const ssl = client()
    const { w, log } = worker(store, ssl)
    await w.tick()
    expect(store.fail).toHaveBeenCalledWith(
      'job-1',
      'UNKNOWN_JOB_KIND',
      'No handler for ssl_revoke',
      true,
    )
    expect(ssl.status).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalled()
  })
})

describe('the SSL worker loop', () => {
  it('reports an empty queue, and leaves a crashed job for its lease', async () => {
    const empty = fakeStore(null)
    await expect(worker(empty, client()).w.tick()).resolves.toBe(false)

    const store = fakeStore(job())
    store.completeInitialize.mockRejectedValueOnce(new Error('database down'))
    const { w, log } = worker(store, client())
    await expect(w.tick()).resolves.toBe(true)
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1' }),
      expect.stringContaining('crashed'),
    )
    expect(store.fail).not.toHaveBeenCalled()
  })

  it('never puts a key, a CSR or a contact in a log line (N13)', async () => {
    const store = fakeStore({
      ...job({
        kind: 'ssl_configure',
        csr: `x${PEM_KEY}`,
        approverEmail: 'a@b.co',
        webServer: 'apache',
        contact: CONTACT,
        payment: null,
      }),
    })
    const ssl = client({
      status: found('WaitingForInstall'),
      configure: { kind: 'rejected', code: 'CSR_INVALID', message: 'bad' },
    })
    const { w, log } = worker(store, ssl)
    await w.tick()
    const logged = JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls])
    expect(logged).not.toContain('PRIVATE KEY')
    expect(logged).not.toContain('CERTIFICATE REQUEST')
    expect(logged).not.toContain('Admiralty')
    expect(logged).not.toContain('ada@example.com')
  })

  it('starts, keeps claiming, and stops', async () => {
    const store = fakeStore(null)
    const { w } = worker(store, client())
    w.start()
    w.start()
    await new Promise((resolve) => setTimeout(resolve, 30))
    await w.stop()
    expect(store.claim.mock.calls.length).toBeGreaterThan(1)
  })

  it('logs a claim that fails, and carries on', async () => {
    const store = fakeStore(null)
    store.claim.mockRejectedValueOnce(new Error('down'))
    const { w, log } = worker(store, client())
    w.start()
    await new Promise((resolve) => setTimeout(resolve, 25))
    await w.stop()
    expect(log.error).toHaveBeenCalledWith(expect.anything(), 'could not claim an SSL job')
  })
})
