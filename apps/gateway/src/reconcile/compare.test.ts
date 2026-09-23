import { describe, expect, it } from 'vitest'
import type { RegistryListing } from '../provisioning/registrar'
import { compareWithRegistry, isSupplierAutoRenew, type OurDomain } from './compare'

const NOW = new Date('2026-09-23T12:00:00.000Z')
const DAY = 86_400_000
const inDays = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString()
const DEFAULT_NS = ['ns1.domainnameapi.com', 'ns2.domainnameapi.com']

const ours = (over: Partial<OurDomain> = {}): OurDomain => ({
  id: 'd1',
  domainName: 'example.com',
  localStatus: 'active',
  expiresAt: inDays(200),
  nameservers: DEFAULT_NS,
  pendingNameservers: null,
  autoRenew: true,
  transferLock: true,
  privacy: false,
  ...over,
})

const listed = (over: Partial<RegistryListing> = {}): RegistryListing => ({
  domainName: 'example.com',
  status: 'Active',
  expiresAt: inDays(200),
  nameservers: DEFAULT_NS,
  transferLock: true,
  privacy: false,
  renewalMode: 'AutoRenew',
  ...over,
})

const compare = (a: OurDomain[], b: RegistryListing[]) => compareWithRegistry(a, b, { now: NOW })

describe('compareWithRegistry (PRD §13.5)', () => {
  it('finds nothing when the records agree, and notes the registry’s view', () => {
    const { updates, findings } = compare([ours()], [listed()])
    expect(findings).toEqual([])
    expect(updates).toEqual([
      { domainId: 'd1', registryStatus: 'Active', renewalMode: 'AutoRenew', events: [] },
    ])
  })

  describe('the supplier’s own auto-renew (backlog L18)', () => {
    it('catches a renewal we did not make, and takes the registry’s expiry', () => {
      const { updates, findings } = compare([ours()], [listed({ expiresAt: inDays(565) })])
      expect(findings).toEqual([
        {
          domainId: 'd1',
          domainName: 'example.com',
          kind: 'supplier_renewed',
          detail: { ours: inDays(200), registry: inDays(565) },
        },
      ])
      expect(updates[0]).toMatchObject({
        expiresAt: inDays(565),
        events: [{ type: 'expiry_updated_from_registry' }],
      })
    })

    it('warns before expiry when the customer said no and the supplier would say yes', () => {
      const { findings } = compare(
        [ours({ autoRenew: false, expiresAt: inDays(30) })],
        [listed({ expiresAt: inDays(30) })],
      )
      expect(findings).toEqual([
        expect.objectContaining({ kind: 'supplier_may_renew', detail: expect.anything() }),
      ])
    })

    it('does not warn while expiry is far off', () => {
      const { findings } = compare(
        [ours({ autoRenew: false, expiresAt: inDays(200) })],
        [listed({ expiresAt: inDays(200) })],
      )
      expect(findings).toEqual([])
    })

    it('does not warn when the supplier renews manually', () => {
      const { findings } = compare(
        [ours({ autoRenew: false, expiresAt: inDays(10) })],
        [listed({ expiresAt: inDays(10), renewalMode: 'Manual' })],
      )
      expect(findings).toEqual([])
    })

    it('ignores the few hours a supplier date can differ by', () => {
      const { findings, updates } = compare(
        [ours({ expiresAt: '2027-09-23T08:44:10.000Z' })],
        [listed({ expiresAt: '2027-09-23T11:44:10.000Z' })],
      )
      expect(findings).toEqual([])
      expect(updates[0]?.expiresAt).toBeUndefined()
    })
  })

  it('reports an expiry that moved earlier', () => {
    const { findings } = compare([ours()], [listed({ expiresAt: inDays(100) })])
    expect(findings[0]?.kind).toBe('expiry_moved_earlier')
  })

  it('reports a domain we hold that the registry no longer lists', () => {
    const { findings, updates } = compare([ours()], [])
    expect(findings).toEqual([
      expect.objectContaining({ kind: 'missing_at_registry', domainId: 'd1' }),
    ])
    expect(updates).toEqual([])
  })

  it('reports a domain the registry lists that we have no record of', () => {
    const { findings } = compare([], [listed({ domainName: 'stray.com' })])
    expect(findings).toEqual([
      expect.objectContaining({ kind: 'unknown_domain', domainName: 'stray.com', domainId: null }),
    ])
  })

  it('reports a line we failed that the registry has anyway', () => {
    const { findings } = compare([ours({ localStatus: 'registration_failed' })], [listed()])
    expect(findings).toEqual([expect.objectContaining({ kind: 'registered_but_failed' })])
  })

  it('leaves a domain still registering to its job', () => {
    expect(compare([ours({ localStatus: 'pending' })], [listed()])).toEqual({
      updates: [],
      findings: [],
    })
  })

  it('checks the held row when a name has a failed and a held row', () => {
    const { findings, updates } = compare(
      [ours({ id: 'old', localStatus: 'registration_failed' }), ours({ id: 'new' })],
      [listed()],
    )
    expect(findings).toEqual([])
    expect(updates.map((update) => update.domainId)).toEqual(['new'])
  })

  it('reports a registry status that disagrees with ours', () => {
    const { findings } = compare([ours()], [listed({ status: 'PendingDelete' })])
    expect(findings).toEqual([
      expect.objectContaining({
        kind: 'status_mismatch',
        detail: { local_status: 'active', registry_status: 'PendingDelete' },
      }),
    ])
  })

  describe('records put straight from the registry', () => {
    it('takes nameservers changed at the registry', () => {
      const vercel = ['ns1.vercel-dns.com', 'ns2.vercel-dns.com']
      const { updates } = compare([ours()], [listed({ nameservers: vercel })])
      expect(updates[0]).toMatchObject({
        nameservers: vercel,
        events: [{ type: 'nameservers_synced', payload: { before: DEFAULT_NS, after: vercel } }],
      })
    })

    it('leaves nameservers alone while a change of ours is waiting', () => {
      const { updates } = compare(
        [ours({ pendingNameservers: ['a.test', 'b.test'] })],
        [listed({ nameservers: ['c.test', 'd.test'] })],
      )
      expect(updates[0]?.nameservers).toBeUndefined()
    })

    it('takes the registry’s lock and privacy', () => {
      const { updates } = compare([ours()], [listed({ transferLock: false, privacy: true })])
      expect(updates[0]).toMatchObject({ transferLock: false, privacy: true })
    })

    it('fills in an expiry we never had', () => {
      const { updates, findings } = compare([ours({ expiresAt: null })], [listed()])
      expect(updates[0]?.expiresAt).toBe(inDays(200))
      expect(findings).toEqual([])
    })
  })

  it('matches names case-insensitively', () => {
    const { findings } = compare([ours({ domainName: 'Example.COM' })], [listed()])
    expect(findings).toEqual([])
  })
})

describe('isSupplierAutoRenew', () => {
  it.each([
    ['AutoRenew', true],
    ['autorenew', true],
    ['Manual', false],
    [null, false],
  ])('%s → %s', (mode, expected) => {
    expect(isSupplierAutoRenew(mode)).toBe(expected)
  })
})
