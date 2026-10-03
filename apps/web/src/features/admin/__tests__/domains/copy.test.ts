import type { AdminRegistryDomain } from '@dr/shared/admin'
import { describe, expect, it } from 'vitest'
import {
  countryWords,
  DEEP_SYNC,
  deepSyncOffer,
  expiryDiffers,
  expiryWords,
  gatewayHeartbeat,
  gatewayStale,
  liveComparison,
  NO_DOMAINS,
  nameserversDiffer,
  nameserverWords,
  type Ours,
  REGISTRY,
  REVEAL,
  registrantTypeWords,
  registryStatusWords,
  renewalModeWords,
  settingWords,
  statusDiffers,
  statusLabel,
  storedComparison,
  verificationWords,
} from '@/features/admin/lib/domains-copy'

const NOW = new Date('2026-10-03T12:00:00Z')
const readAt = '2026-10-03T11:05:00.000Z'

const ours: Ours = {
  status: 'active',
  expiresAt: '2027-03-01T10:00:00Z',
  transferLock: true,
  privacy: false,
  nameservers: ['ns2.example-dns.net', 'NS1.example-dns.net'],
}

function registry(overrides: Partial<AdminRegistryDomain> = {}): AdminRegistryDomain {
  return {
    name: 'getpaid.com',
    outcome: 'ok',
    status: 'Active',
    statusCode: '0',
    expiresAt: '2027-03-01T12:00:00Z',
    rgpExpiresAt: null,
    transferLock: true,
    privacy: false,
    nameservers: ['ns1.example-dns.net', 'ns2.example-dns.net'],
    readAt,
    ...overrides,
  }
}

describe('the deep sync copy (§5.2 B9)', () => {
  it('says exactly what the spec says', () => {
    expect(DEEP_SYNC.title('example.com')).toBe(
      'Read example.com from the registry on the next sync?',
    )
    expect(DEEP_SYNC.body).toBe(
      'The next deep sync, within an hour, reads it and corrects our record from the registry. Nothing changes at the registry.',
    )
    expect(DEEP_SYNC.noGateway('test')).toBe(
      'No sandbox gateway is reading test domains right now, so nothing would read it.',
    )
    expect(DEEP_SYNC.noGateway('live')).toBe(
      'No gateway is reading live domains right now, so nothing would read it.',
    )
  })

  it('is offered only on live, syncable domains that were at a registry', () => {
    for (const status of ['active', 'expired_grace', 'redemption']) {
      expect(deepSyncOffer({ status, source: 'registration' })).toEqual({ offered: true })
    }
    for (const status of ['pending', 'pending_delete', 'transfer_pending', 'released', null]) {
      expect(deepSyncOffer({ status, source: 'registration' })).toEqual({
        offered: false,
        words: DEEP_SYNC.notSyncable,
      })
    }
    expect(deepSyncOffer({ status: 'active', source: 'demo' })).toEqual({
      offered: false,
      words: DEEP_SYNC.demo,
    })
  })

  it('reads a heartbeat as stale after 15 minutes, or when there is none', () => {
    expect(gatewayStale('2026-10-03T11:50:00Z', NOW)).toBe(false)
    expect(gatewayStale('2026-10-03T11:44:59Z', NOW)).toBe(true)
    expect(gatewayStale(null, NOW)).toBe(true)
    expect(gatewayStale('not a date', NOW)).toBe(true)
    expect(gatewayHeartbeat('test')).toBe('gateway:ote')
    expect(gatewayHeartbeat('live')).toBe('gateway:production')
    expect(DEEP_SYNC.last('2026-10-03T11:00:00Z')).toBe(
      'Last read by the deep sync 3 Oct 2026 at 12:00 WAT.',
    )
  })
})

describe('the registry renewal mode (BACKLOG L18)', () => {
  it("names the supplier's label, and says automatic renewal isn't ours to use", () => {
    expect(renewalModeWords('AutoRenew')).toBe(
      "Registry renewal mode 'AutoRenew' (the supplier's label; automatic renewal isn't available to our account, BACKLOG L18)",
    )
    expect(renewalModeWords('unknown')).toBe('Registry renewal mode not read yet')
    expect(renewalModeWords(null)).toBe('Registry renewal mode not read yet')
    expect(renewalModeWords('x'.repeat(60))).toContain(`'${'x'.repeat(40)}'`)
  })
})

describe('our record beside the registry', () => {
  it('judges an active domain as the reconcile does: active or ok match', () => {
    expect(statusDiffers('active', 'Active')).toBe(false)
    expect(statusDiffers('active', ' ok ')).toBe(false)
    expect(statusDiffers('active', 'ClientHold')).toBe(true)
    // Other statuses use words of their own at the registry: not judged.
    expect(statusDiffers('redemption', 'RedemptionPeriod')).toBe(false)
    expect(statusDiffers('active', null)).toBe(false)
  })

  it('allows a day between expiries, and compares nameservers as sets', () => {
    expect(expiryDiffers('2027-03-01T10:00:00Z', '2027-03-02T09:00:00Z')).toBe(false)
    expect(expiryDiffers('2027-03-01T10:00:00Z', '2028-03-01T10:00:00Z')).toBe(true)
    expect(expiryDiffers(null, '2028-03-01T10:00:00Z')).toBe(false)
    expect(expiryDiffers('nope', '2028-03-01T10:00:00Z')).toBe(false)
    expect(nameserversDiffer(['NS1.a.net', 'ns2.a.net'], ['ns2.a.net', 'ns1.a.net'])).toBe(false)
    expect(nameserversDiffer(['ns1.a.net', 'ns2.a.net'], ['ns1.b.net', 'ns2.b.net'])).toBe(true)
    expect(nameserversDiffer(['ns1.a.net'], ['ns1.a.net', 'ns2.a.net'])).toBe(true)
    // The registry listed none: nothing to judge.
    expect(nameserversDiffer(['ns1.a.net'], [])).toBe(false)
    expect(nameserverWords(['NS2.a.net', 'ns1.a.net', 'ns1.a.net'])).toBe('ns1.a.net, ns2.a.net')
    expect(nameserverWords([])).toBe('None')
  })

  it('shows what the hourly check stored until someone reads the registry', () => {
    expect(
      storedComparison(ours, { registryStatus: 'Active', checkedAt: '2026-10-03T10:00:00Z' }),
    ).toEqual([{ label: 'Status', ours: 'Active', theirs: 'Active', differs: false }])
    expect(storedComparison(ours, { registryStatus: null, checkedAt: null })).toEqual([
      { label: 'Status', ours: 'Active', theirs: 'Not read yet', differs: false },
    ])
    expect(REGISTRY.storedCaption(null)).toBe(
      'Our record beside the registry: the hourly check has not read this domain yet',
    )
    expect(REGISTRY.storedCaption('2026-10-03T10:00:00Z')).toBe(
      'Our record beside what the hourly registry check stored, 3 Oct 2026 at 11:00 WAT',
    )
  })

  it('sets every field of a live read beside ours, marking what differs', () => {
    expect(liveComparison(ours, registry())).toEqual([
      { label: 'Status', ours: 'Active', theirs: 'Active', differs: false },
      { label: 'Expires', ours: '1 Mar 2027', theirs: '1 Mar 2027', differs: false },
      { label: 'Transfer lock', ours: 'On', theirs: 'On', differs: false },
      { label: 'Privacy', ours: 'Off', theirs: 'Off', differs: false },
      {
        label: 'Nameservers',
        ours: 'ns1.example-dns.net, ns2.example-dns.net',
        theirs: 'ns1.example-dns.net, ns2.example-dns.net',
        differs: false,
      },
    ])
    const moved = liveComparison(
      ours,
      registry({
        status: 'ClientHold',
        expiresAt: '2028-03-01T12:00:00Z',
        transferLock: false,
        privacy: null,
        nameservers: [],
      }),
    )
    expect(moved.filter((row) => row.differs).map((row) => row.label)).toEqual([
      'Status',
      'Expires',
      'Transfer lock',
    ])
    expect(moved.find((row) => row.label === 'Privacy')?.theirs).toBe('Not read')
    expect(moved.find((row) => row.label === 'Nameservers')?.theirs).toBe('Not read')
  })

  it('says a domain the registry does not have is missing, when we hold it', () => {
    expect(liveComparison(ours, registry({ outcome: 'not_found' }))).toEqual([
      { label: 'Status', ours: 'Active', theirs: 'Not in our account', differs: true },
    ])
    expect(
      liveComparison(
        { ...ours, status: 'registration_failed' },
        registry({ outcome: 'not_found' }),
      ),
    ).toEqual([
      {
        label: 'Status',
        ours: 'Registration failed',
        theirs: 'Not in our account',
        differs: false,
      },
    ])
    expect(REGISTRY.differs(1)).toMatch(/^1 field differs\./)
    expect(REGISTRY.differs(3)).toMatch(/^3 fields differ\./)
    expect(REGISTRY.liveCaption(readAt)).toBe('Our record beside the registry, read at 12:05 WAT')
  })

  it("keeps the registry's status label short and spaced", () => {
    expect(registryStatusWords('Pending_Delete')).toBe('Pending Delete')
    expect(registryStatusWords('  ')).toBe('Not read yet')
    expect(registryStatusWords('x'.repeat(50))).toHaveLength(40)
  })
})

describe('registrant verification, read live', () => {
  const verified = {
    name: 'getpaid.com',
    isVerified: true,
    operationStatus: 'Done',
    verifiedAt: '2026-09-30T08:00:00Z',
    fieldType: 'Email',
    readAt,
  }

  it("says whether it is verified, never the supplier's operation word", () => {
    expect(verificationWords(verified)).toBe('Read at 12:05 WAT: verified (Email) on 30 Sept 2026')
    expect(verificationWords({ ...verified, verifiedAt: null })).toBe(
      'Read at 12:05 WAT: verified (Email)',
    )
    expect(verificationWords({ ...verified, isVerified: false, fieldType: null })).toBe(
      'Read at 12:05 WAT: not verified yet',
    )
    // Anything but a plain word for the field kind is left out.
    expect(verificationWords({ ...verified, fieldType: '<b>x</b>' })).not.toContain('<b>')
    expect(verificationWords({ ...verified, isVerified: false })).not.toContain('Done')
  })

  it('says when the registry lists none', () => {
    expect(verificationWords(null)).toBe('the registry lists no verification for this domain')
    expect(verificationWords(null, readAt)).toBe(
      'Read at 12:05 WAT: the registry lists no verification for this domain',
    )
  })
})

describe('the summary words', () => {
  it('says a setting and the change waiting beside it', () => {
    expect(settingWords(true)).toBe('On')
    expect(settingWords(false, null)).toBe('Off')
    expect(settingWords(true, true)).toBe('On')
    expect(settingWords(true, false)).toBe('On — turning off')
    expect(settingWords(null, true)).toBe('Not known — turning on')
  })

  it('says when a domain expires, from now', () => {
    expect(expiryWords('2026-10-13T12:00:00Z', NOW)).toBe('Expires in 10 days')
    expect(expiryWords('2026-09-30T12:00:00Z', NOW)).toBe('Expired 3 days ago')
    expect(expiryWords(null, NOW)).toBe('No expiry yet')
    expect(expiryWords('soon', NOW)).toBe('No expiry yet')
  })

  it('names a country from the static map, and the registrant type', () => {
    expect(countryWords('ng')).toBe('Nigeria (NG)')
    expect(countryWords('ZZ')).toBe('ZZ')
    expect(countryWords(null)).toBe('Not given')
    expect(registrantTypeWords('organisation')).toBe('Organisation')
    expect(registrantTypeWords('individual')).toBe('Individual')
    expect(registrantTypeWords('other')).toBe('other')
    expect(registrantTypeWords(null)).toBe('Not given')
  })

  it("names a status as the customer's panel does", () => {
    expect(statusLabel('pending')).toBe('Registering')
    expect(statusLabel('expired_grace')).toBe('Expired')
    expect(statusLabel('brand_new')).toBe('brand new')
    expect(statusLabel(null)).toBe('—')
    expect(NO_DOMAINS('test')).toBe('No domains on the Test side yet.')
  })

  it('tells the admin the reveal is audited', () => {
    expect(REVEAL.title('getpaid.com')).toBe('Show the registrant of getpaid.com?')
    expect(REVEAL.body).toContain('Your view is recorded in the audit log.')
  })
})
