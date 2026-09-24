import { describe, expect, it } from 'vitest'
import { judgeNameservers, sameNameservers } from '../lib/nameserver-check'
import {
  daysUntilExpiry,
  filterPortfolio,
  type PortfolioDomain,
  parseExpiryWindow,
} from '../lib/portfolio'

const NOW = new Date('2026-09-23T12:00:00Z')
const inDays = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString()

const domain = (name: string, expiresInDays: number | null): PortfolioDomain => ({
  id: name,
  domainName: name,
  tld: 'com',
  source: 'demo',
  testMode: false,
  status: 'active',
  expiresAt: expiresInDays === null ? null : inDays(expiresInDays),
  autoRenew: true,
  privacyEnabled: true,
  transferLock: true,
  delegationStatus: 'undelegated',
  nameservers: null,
  pendingNameservers: null,
  labels: [],
})

describe('portfolio (FR-P2, FR-P5)', () => {
  const all = [
    domain('later.com', 200),
    domain('soon.com', 12),
    domain('gone.com', -6),
    domain('queued.com', null),
  ]

  it('puts the soonest expiry first and unregistered domains last', () => {
    expect(filterPortfolio(all, {}, NOW).map((d) => d.domainName)).toEqual([
      'gone.com',
      'soon.com',
      'later.com',
      'queued.com',
    ])
  })

  it('shows expired domains in every expiry window — they need attention most', () => {
    expect(filterPortfolio(all, { expiringWithin: 30 }, NOW).map((d) => d.domainName)).toEqual([
      'gone.com',
      'soon.com',
    ])
  })

  it('searches by name, ignoring case and a leading dot', () => {
    expect(filterPortfolio(all, { query: ' SOON ' }, NOW).map((d) => d.domainName)).toEqual([
      'soon.com',
    ])
    expect(filterPortfolio(all, { query: '.com' }, NOW)).toHaveLength(4)
  })

  it('counts whole days, negative once expired', () => {
    expect(daysUntilExpiry(inDays(12.5), NOW)).toBe(12)
    expect(daysUntilExpiry(inDays(-6), NOW)).toBe(-6)
    expect(daysUntilExpiry(null, NOW)).toBeNull()
  })

  it('accepts only the offered windows from the URL', () => {
    expect(parseExpiryWindow('30')).toBe(30)
    expect(parseExpiryWindow('45')).toBeNull()
    expect(parseExpiryWindow(undefined)).toBeNull()
  })
})

describe('judgeNameservers (FR-D4)', () => {
  it('blocks a nameserver that does not exist — the typo case', () => {
    const verdict = judgeNameservers(
      'getpaid.com',
      new Map([
        ['ns1.whogohst.com', 'nxdomain'],
        ['ns2.vercel-dns.com', 'resolves'],
      ]),
    )
    expect(verdict.blocking).toEqual(["ns1.whogohst.com doesn't exist — check the spelling."])
  })

  it('only warns when a real nameserver did not answer just now', () => {
    const verdict = judgeNameservers(
      'getpaid.com',
      new Map([
        ['ns1.busy.com', 'no-answer'],
        ['ns2.busy.com', 'resolves'],
      ]),
    )
    expect(verdict.blocking).toEqual([])
    expect(verdict.warnings).toHaveLength(1)
  })

  it('blocks nameservers inside the domain itself, which need glue', () => {
    const verdict = judgeNameservers(
      'getpaid.com',
      new Map([
        ['ns1.getpaid.com', 'resolves'],
        ['ns2.host.com', 'resolves'],
      ]),
    )
    expect(verdict.blocking[0]).toMatch(/needs glue records/)
  })
})

describe('sameNameservers', () => {
  it('ignores order and case', () => {
    expect(sameNameservers(['NS2.a.com', 'ns1.a.com'], ['ns1.a.com', 'ns2.a.com'])).toBe(true)
    expect(sameNameservers(['ns1.a.com', 'ns2.a.com'], ['ns1.a.com', 'ns3.a.com'])).toBe(false)
    expect(sameNameservers(null, ['ns1.a.com'])).toBe(false)
  })
})
