import DomainNameApi from 'nodejs-dna'
import { describe, expect, it, vi } from 'vitest'
import { createTransport } from '../dna/transport'
import { Semaphore } from '../lib/semaphore'
import type {
  CallRecord,
  Lookup,
  Registrar,
  RegistryDomain,
  RegistryListing,
} from '../provisioning/registrar'
import { compareWithRegistry, type OurDomain } from './compare'
import {
  asListing,
  createDeepSync,
  createDeepSyncReader,
  DEEP_SYNC_SLOT,
  readingFor,
} from './deep-sync'
import type { DeepReading, DeepSyncStore } from './deep-sync-store'

/**
 * The deep sync (PRD §13.5): one domain's GetDetails against our row, judged
 * by the reconcile's own comparison. The registry and the store are fakes;
 * the slot tests drive the real SDK over a fake network.
 */

const NOW = new Date('2026-09-24T12:00:00.000Z')
const DAY = 86_400_000
const inDays = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString()
const DEFAULT_NS = ['ns1.domainnameapi.com', 'ns2.domainnameapi.com']
const VERCEL = ['ns1.vercel-dns.com', 'ns2.vercel-dns.com']

const ours = (id = 'd1', over: Partial<OurDomain> = {}): OurDomain => ({
  id,
  domainName: `${id}.com`,
  localStatus: 'active',
  expiresAt: inDays(200),
  nameservers: DEFAULT_NS,
  pendingNameservers: null,
  autoRenew: true,
  transferLock: true,
  privacy: false,
  ...over,
})

const record = (over: Partial<RegistryDomain> = {}): RegistryDomain => ({
  registeredAt: inDays(-165),
  expiresAt: inDays(200),
  nameservers: DEFAULT_NS,
  transferLock: true,
  privacy: false,
  status: 'Active',
  ...over,
})

const found = (over: Partial<RegistryDomain> = {}) => ({
  kind: 'found' as const,
  domain: record(over),
})

function fakeStore(queue: OurDomain[]) {
  const recorded: { domainId: string; testMode: boolean; reading: DeepReading }[] = []
  const store = {
    due: vi.fn(async (_testMode: boolean, limit: number) => queue.slice(0, limit)),
    record: vi.fn(async (domainId: string, testMode: boolean, reading: DeepReading) => {
      recorded.push({ domainId, testMode, reading })
    }),
  } satisfies DeepSyncStore
  return { store, recorded }
}

/** Answers by domain name; any name not listed agrees with `ours()`. */
function registry(byName: Record<string, Lookup> = {}) {
  return { lookup: vi.fn(async (name: string): Promise<Lookup> => byName[name] ?? found()) }
}

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

function deepSync(
  store: DeepSyncStore,
  reader: Pick<Registrar, 'lookup'> = registry(),
  over: Record<string, unknown> = {},
) {
  const logger = log()
  const instance = createDeepSync({
    store,
    reader,
    testMode: false,
    everyMs: 3_600_000,
    log: logger,
    now: () => NOW,
    ...over,
  })
  return { instance, logger }
}

describe('reading one domain', () => {
  it('stamps only when the registry agrees', () => {
    expect(readingFor(ours(), found(), { now: NOW })).toEqual({ update: null, findings: [] })
  })

  it('corrects what the portfolio reconcile would, with the same events', () => {
    const answer = record({ expiresAt: inDays(565), nameservers: VERCEL, privacy: true })
    const reading = readingFor(ours(), { kind: 'found', domain: answer }, { now: NOW })

    // The portfolio run, given GetList's line for the same domain.
    const line: RegistryListing = { ...asListing('d1.com', answer), renewalMode: 'AutoRenew' }
    const portfolio = compareWithRegistry([ours()], [line], { now: NOW })
    expect(reading.update).toEqual({ ...portfolio.updates[0], renewalMode: null })
    expect(reading.findings).toEqual(portfolio.findings)

    expect(reading.update).toEqual({
      domainId: 'd1',
      registryStatus: 'Active',
      renewalMode: null,
      expiresAt: inDays(565),
      nameservers: VERCEL,
      privacy: true,
      events: [
        {
          type: 'expiry_updated_from_registry',
          payload: { before: inDays(200), after: inDays(565) },
        },
        { type: 'nameservers_synced', payload: { before: DEFAULT_NS, after: VERCEL } },
      ],
    })
    expect(reading.findings.map((finding) => finding.kind)).toEqual(['supplier_renewed'])
  })

  it('never guesses the supplier’s renewal mode — the lookup does not keep it', () => {
    // Customer auto-renew off, expiry close: GetList's "AutoRenew" would warn.
    const soon = ours('d1', { autoRenew: false, expiresAt: inDays(10) })
    const answer = record({ expiresAt: inDays(10) })
    const line = { ...asListing('d1.com', answer), renewalMode: 'AutoRenew' }
    expect(
      compareWithRegistry([soon], [line], { now: NOW }).findings.map((finding) => finding.kind),
    ).toEqual(['supplier_may_renew'])

    expect(asListing('D1.com', answer).renewalMode).toBeNull()
    expect(readingFor(soon, { kind: 'found', domain: answer }, { now: NOW })).toEqual({
      update: null,
      findings: [],
    })
  })

  it('reads a domain the registry does not have as missing, as the portfolio run would', () => {
    const reading = readingFor(ours(), { kind: 'not_found' }, { now: NOW })
    expect(reading).toEqual({
      update: null,
      findings: [
        {
          domainId: 'd1',
          domainName: 'd1.com',
          kind: 'missing_at_registry',
          detail: { local_status: 'active' },
        },
      ],
    })
    expect(reading).toEqual({
      update: null,
      findings: compareWithRegistry([ours()], [], { now: NOW }).findings,
    })
  })

  it('leaves a transfer under way to its job, found or not', () => {
    const moving = ours('d1', { localStatus: 'transfer_pending' })
    expect(readingFor(moving, { kind: 'not_found' }, { now: NOW })).toEqual({
      update: null,
      findings: [],
    })
    expect(
      readingFor(moving, found({ status: 'WaitingForIncomingTransfer' }), { now: NOW }),
    ).toEqual({ update: null, findings: [] })
  })

  it('flags a registry status that disagrees, and records it on the domain', () => {
    const reading = readingFor(ours(), found({ status: 'PendingDelete' }), { now: NOW })
    expect(reading.findings.map((finding) => finding.kind)).toEqual(['status_mismatch'])
    expect(reading.update).toEqual({
      domainId: 'd1',
      registryStatus: 'PendingDelete',
      renewalMode: null,
      events: [],
    })
  })

  it('reads an answer without a status as saying nothing about the status', () => {
    expect(readingFor(ours(), found({ status: '' }), { now: NOW })).toEqual({
      update: null,
      findings: [],
    })
    const { status: _none, ...bare } = record()
    expect(readingFor(ours(), { kind: 'found', domain: bare }, { now: NOW })).toEqual({
      update: null,
      findings: [],
    })
    const locked = readingFor(ours(), found({ status: '', transferLock: false }), { now: NOW })
    expect(locked.update).toMatchObject({ registryStatus: '', transferLock: false })
  })

  it('leaves nameservers alone while a change of ours is waiting', () => {
    const waiting = ours('d1', { pendingNameservers: VERCEL })
    expect(readingFor(waiting, found({ nameservers: VERCEL }), { now: NOW })).toEqual({
      update: null,
      findings: [],
    })
  })
})

describe('the deep sync', () => {
  it('asks for a batch of 25 on its own side, and stamps each domain the registry agrees on', async () => {
    const { store, recorded } = fakeStore([ours('a'), ours('b')])
    const { instance, logger } = deepSync(store)
    await expect(instance.runOnce()).resolves.toEqual({
      due: 2,
      read: 2,
      agreed: 2,
      corrected: 0,
      skipped: 0,
      findings: {},
    })
    expect(store.due).toHaveBeenCalledWith(false, 25)
    expect(recorded).toEqual([
      { domainId: 'a', testMode: false, reading: { update: null, findings: [] } },
      { domainId: 'b', testMode: false, reading: { update: null, findings: [] } },
    ])
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ due: 2 }),
      'deep sync finished',
    )
  })

  it('records the corrections and findings for a domain that differs', async () => {
    const { store, recorded } = fakeStore([ours('a')])
    const reader = registry({ 'a.com': found({ nameservers: VERCEL, expiresAt: inDays(565) }) })
    const { instance, logger } = deepSync(store, reader, { testMode: true })
    await expect(instance.runOnce()).resolves.toMatchObject({
      corrected: 1,
      findings: { supplier_renewed: 1 },
    })
    expect(recorded[0]?.testMode).toBe(true)
    expect(recorded[0]?.reading.update?.events.map((event) => event.type)).toEqual([
      'expiry_updated_from_registry',
      'nameservers_synced',
    ])
    // A renewal we did not make costs money: said at error level.
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ findings: { supplier_renewed: 1 } }),
      'deep sync finished',
    )
  })

  it('warns about findings that need a look but cost nothing', async () => {
    const { store } = fakeStore([ours('a')])
    const { instance, logger } = deepSync(
      store,
      registry({ 'a.com': found({ status: 'ClientHold' }) }),
    )
    await instance.runOnce()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ findings: { status_mismatch: 1 } }),
      'deep sync finished',
    )
  })

  it('records a domain the registry does not have', async () => {
    const { store, recorded } = fakeStore([ours('a')])
    const { instance } = deepSync(store, registry({ 'a.com': { kind: 'not_found' } }))
    await expect(instance.runOnce()).resolves.toMatchObject({
      read: 1,
      corrected: 0,
      agreed: 0,
      findings: { missing_at_registry: 1 },
    })
    expect(recorded[0]?.reading).toEqual({
      update: null,
      findings: [expect.objectContaining({ kind: 'missing_at_registry' })],
    })
  })

  it('records nothing for a domain the registry did not answer about, and reads the next', async () => {
    const { store, recorded } = fakeStore([ours('a'), ours('b')])
    const reader = registry({ 'a.com': { kind: 'unknown', code: 'TIMEOUT', message: 'No answer' } })
    const { instance, logger } = deepSync(store, reader)
    await expect(instance.runOnce()).resolves.toMatchObject({ skipped: 1, read: 1, agreed: 1 })
    expect(recorded.map((entry) => entry.domainId)).toEqual(['b'])
    expect(logger.warn).toHaveBeenCalledWith(
      { domainId: 'a', code: 'TIMEOUT' },
      'deep sync: no answer from the registry, nothing recorded',
    )
  })

  it('stops the run when the supplier refuses us — every other read would be refused too', async () => {
    const { store, recorded } = fakeStore([ours('a'), ours('b')])
    const reader = registry({
      'a.com': { kind: 'blocked', code: 'SUPPLIER_IP_BLOCKED', message: 'Not allowlisted' },
    })
    const { instance, logger } = deepSync(store, reader)
    await expect(instance.runOnce()).resolves.toMatchObject({ skipped: 1, read: 0 })
    expect(reader.lookup).toHaveBeenCalledTimes(1)
    expect(recorded).toEqual([])
    expect(logger.error).toHaveBeenCalledWith(
      { domainId: 'a', code: 'SUPPLIER_IP_BLOCKED' },
      'deep sync stopped: the supplier refused the read',
    )
  })

  it('reads one domain at a time', async () => {
    let inFlight = 0
    let most = 0
    const reader = {
      lookup: async (): Promise<Lookup> => {
        inFlight += 1
        most = Math.max(most, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 1))
        inFlight -= 1
        return found()
      },
    }
    const { store } = fakeStore(Array.from({ length: 5 }, (_, index) => ours(`d${index}`)))
    const { instance } = deepSync(store, reader)
    await instance.runOnce()
    expect(most).toBe(1)
  })

  it('says nothing when nothing is due', async () => {
    const { store } = fakeStore([])
    const { instance, logger } = deepSync(store)
    await expect(instance.runOnce()).resolves.toMatchObject({ due: 0 })
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('logs a failed run and carries on at the next interval', async () => {
    vi.useFakeTimers()
    try {
      const { store } = fakeStore([ours('a')])
      store.due.mockRejectedValueOnce(new Error('database down'))
      const { instance, logger } = deepSync(store)
      instance.start()
      instance.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(logger.error).toHaveBeenCalledWith({ err: expect.any(Error) }, 'deep sync failed')
      await vi.advanceTimersByTimeAsync(3_600_000)
      expect(store.record).toHaveBeenCalledTimes(1)
      await instance.stop()
      await vi.advanceTimersByTimeAsync(24 * 3_600_000)
      expect(store.due).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops cleanly when stopped mid-run', async () => {
    const { store, recorded } = fakeStore([ours('a')])
    const { instance } = deepSync(store)
    instance.start()
    await instance.stop()
    expect(recorded).toHaveLength(1)
  })
})

describe('the deep sync’s supplier slot', () => {
  const DETAILS = {
    status: 'Active',
    domainName: 'd1.com',
    startDate: '2026-04-12T12:00:00',
    expirationDate: '2027-04-12T12:00:00',
    lockStatus: true,
    privacyProtectionStatus: false,
    nameservers: DEFAULT_NS,
  }

  function setup(slots: Semaphore) {
    const client = new DomainNameApi('00000000-0000-0000-0000-000000000000', 'key', {
      testMode: true,
      telemetry: false,
    })
    const paths: string[] = []
    client.client._axios = createTransport((async (url: string | URL | Request) => {
      paths.push(new URL(String(url)).pathname)
      return Response.json(DETAILS)
    }) as typeof fetch)
    const calls: CallRecord[] = []
    const reader = createDeepSyncReader({
      client,
      environment: 'ote',
      audit: async (call) => {
        calls.push(call)
      },
      slots,
    })
    return { reader, calls, paths }
  }

  it('waits in the low lane, and gives up on a slot in time', async () => {
    const slots = new Semaphore(2, 1)
    const run = vi.spyOn(slots, 'run')
    const { reader, calls } = setup(slots)
    await expect(reader.lookup('d1.com')).resolves.toMatchObject({ kind: 'found' })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[1]).toEqual({ waitMs: 120_000, priority: 'low' })
    expect(DEEP_SYNC_SLOT).toEqual({ waitMs: 120_000, priority: 'low' })
    // Recorded in supplier_calls like every job's read (I7).
    expect(calls).toMatchObject([{ operation: 'GetDetails', domainName: 'd1.com', outcome: 'ok' }])
  })

  it('never takes the second slot while another low-lane call holds the first', async () => {
    const slots = new Semaphore(2, 1)
    const { reader, paths } = setup(slots)
    let release = () => {}
    const bulk = slots.run(() => new Promise<void>((resolve) => (release = resolve)), {
      priority: 'low',
    })

    const reading = reader.lookup('d1.com')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(slots.inFlight).toBe(1)
    expect(paths).toEqual([])

    release()
    await bulk
    await expect(reading).resolves.toMatchObject({ kind: 'found' })
    expect(paths).toHaveLength(1)
  })
})
