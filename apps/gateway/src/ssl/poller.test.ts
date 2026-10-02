import { describe, expect, it, vi } from 'vitest'
import type { SslClient } from './client'
import { caBundle, createSslPoller, nextCheckSeconds } from './poller'
import type { CertificateToCheck, SslStore } from './store'

/** FR-SSL-7: where each certificate stands, read in the low lane, never guessed. */

const NOW = new Date('2026-10-02T12:00:00Z')
const PEM = '-----BEGIN CERTIFICATE-----\nMIIF\n-----END CERTIFICATE-----'
const CHAIN = '-----BEGIN CERTIFICATE-----\nMIIChain\n-----END CERTIFICATE-----'

const cert = (over: Partial<CertificateToCheck> = {}): CertificateToCheck => ({
  id: 'cert-1',
  commonName: 'example.com',
  status: 'awaiting_validation',
  isWildcard: false,
  configuredAt: '2026-10-02T11:50:00Z',
  hasCertificate: false,
  ...over,
})

function store(due: CertificateToCheck[]) {
  return {
    toCheck: vi.fn(async () => due),
    recordStatus: vi.fn(async () => {}),
  } as unknown as SslStore & {
    toCheck: ReturnType<typeof vi.fn>
    recordStatus: ReturnType<typeof vi.fn>
  }
}

function supplier(over: Partial<Record<keyof SslClient, unknown>>): SslClient {
  return Object.fromEntries(
    Object.entries(over).map(([key, value]) => [key, vi.fn(async () => value)]),
  ) as unknown as SslClient
}

const status = (word: string, expires: string | null = null) => ({
  kind: 'found',
  data: {
    domainName: 'example.com',
    status: word,
    isConfigured: true,
    isIssued: word === 'Active',
    certificateExpiresAt: expires,
  },
})

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

describe('how often a certificate is asked about', () => {
  it('asks soon after the set-up, then less and less often', () => {
    const at = (minutesAgo: number) => ({
      configuredAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
    })
    expect(nextCheckSeconds(at(10), 'awaiting_validation', false, NOW)).toBe(300)
    expect(nextCheckSeconds(at(120), 'awaiting_validation', false, NOW)).toBe(900)
    expect(nextCheckSeconds(at(3 * 24 * 60), 'awaiting_validation', false, NOW)).toBe(3600)
    expect(nextCheckSeconds(at(30 * 24 * 60), null, false, NOW)).toBe(6 * 3600)
    expect(nextCheckSeconds({ configuredAt: null }, null, false, NOW)).toBe(300)
  })

  it('asks hourly for an issued certificate’s text until it has it', () => {
    expect(nextCheckSeconds(cert(), 'issued', false, NOW)).toBe(3600)
    expect(nextCheckSeconds(cert(), 'issued', true, NOW)).toBe(24 * 3600)
  })

  it('puts the chain together, intermediates first', () => {
    expect(caBundle({ certificate: PEM, intermediates: [CHAIN, 'second'], root: 'root' })).toBe(
      `${CHAIN}\nsecond\nroot`,
    )
    expect(caBundle({ certificate: PEM, intermediates: [], root: '' })).toBe('')
  })
})

describe('the SSL status poller', () => {
  it('records an approver still to act, and asks again soon', async () => {
    const s = store([cert()])
    const poller = createSslPoller({
      store: s,
      client: supplier({ status: status('WaitingForValidation') }),
      testMode: true,
      everyMs: 1000,
      log: log(),
      now: () => NOW,
    })
    await expect(poller.runOnce()).resolves.toEqual({ checked: 1, skipped: 0 })
    expect(s.toCheck).toHaveBeenCalledWith(true, 10)
    expect(s.recordStatus).toHaveBeenCalledWith('cert-1', {
      supplierStatus: 'WaitingForValidation',
      state: 'awaiting_validation',
      issuedAt: null,
      expiresAt: null,
      certificate: null,
      caBundle: null,
      nextCheckSeconds: 300,
    })
  })

  it('keeps an issued certificate, its chain and its dates', async () => {
    const s = store([cert()])
    const client = supplier({
      status: status('Active', '2027-04-20T11:54:19.000Z'),
      content: { kind: 'found', data: { certificate: PEM, intermediates: [CHAIN], root: '' } },
      details: {
        kind: 'found',
        data: {
          status: 'Active',
          packageCode: '351',
          isConfigured: true,
          isIssued: true,
          purchasedAt: null,
          subscriptionEndsAt: null,
          issuedAt: '2026-10-02T11:54:38.000Z',
          validUntil: '2027-04-20T11:54:38.000Z',
        },
      },
    })
    await createSslPoller({
      store: s,
      client,
      testMode: false,
      everyMs: 1000,
      log: log(),
      now: () => NOW,
    }).runOnce()
    expect(s.recordStatus).toHaveBeenCalledWith('cert-1', {
      supplierStatus: 'Active',
      state: 'issued',
      issuedAt: '2026-10-02T11:54:38.000Z',
      expiresAt: '2027-04-20T11:54:38.000Z',
      certificate: PEM,
      caBundle: CHAIN,
      nextCheckSeconds: 24 * 3600,
    })
  })

  it('records issued without text when the supplier has none yet (the sandbox never has)', async () => {
    const s = store([cert({ isWildcard: true, commonName: '*.example.com' })])
    const client = supplier({
      status: status('Active', '2027-04-20T11:54:19.000Z'),
      content: { kind: 'found', data: { certificate: '', intermediates: [], root: '' } },
    })
    await createSslPoller({
      store: s,
      client,
      testMode: true,
      everyMs: 1000,
      log: log(),
      now: () => NOW,
    }).runOnce()
    expect(s.recordStatus).toHaveBeenCalledWith(
      'cert-1',
      expect.objectContaining({
        state: 'issued',
        certificate: null,
        expiresAt: '2027-04-20T11:54:19.000Z',
        nextCheckSeconds: 3600,
      }),
    )
  })

  it('records a word it does not know without moving the certificate', async () => {
    const s = store([cert()])
    await createSslPoller({
      store: s,
      client: supplier({ status: status('Suspended') }),
      testMode: true,
      everyMs: 1000,
      log: log(),
      now: () => NOW,
    }).runOnce()
    expect(s.recordStatus).toHaveBeenCalledWith(
      'cert-1',
      expect.objectContaining({ supplierStatus: 'Suspended', state: null }),
    )
  })

  it('flags a certificate the supplier cannot find, and skips one it could not read', async () => {
    const s = store([cert(), cert({ id: 'cert-2' })])
    const answers = [{ kind: 'not_found' }, { kind: 'unknown', code: 'TIMEOUT', message: 'slow' }]
    const client = { status: vi.fn(async () => answers.shift()) } as unknown as SslClient
    const l = log()
    await expect(
      createSslPoller({
        store: s,
        client,
        testMode: true,
        everyMs: 1000,
        log: l,
        now: () => NOW,
      }).runOnce(),
    ).resolves.toEqual({ checked: 1, skipped: 1 })
    expect(s.recordStatus).toHaveBeenCalledTimes(1)
    expect(s.recordStatus).toHaveBeenCalledWith(
      'cert-1',
      expect.objectContaining({ supplierStatus: 'NotFound', state: null }),
    )
    expect(l.warn).toHaveBeenCalled()
  })

  it('carries on past a certificate whose record fails, and runs on a timer until stopped', async () => {
    const s = store([cert(), cert({ id: 'cert-2' })])
    s.recordStatus.mockRejectedValueOnce(new Error('db'))
    const l = log()
    const poller = createSslPoller({
      store: s,
      client: supplier({ status: status('WaitingForValidation') }),
      testMode: true,
      everyMs: 5,
      log: l,
      now: () => NOW,
    })
    await expect(poller.runOnce()).resolves.toEqual({ checked: 1, skipped: 1 })
    expect(l.error).toHaveBeenCalled()

    s.toCheck.mockRejectedValueOnce(new Error('db down'))
    poller.start()
    poller.start()
    await new Promise((resolve) => setTimeout(resolve, 30))
    await poller.stop()
    expect(s.toCheck.mock.calls.length).toBeGreaterThan(2)
  })
})
