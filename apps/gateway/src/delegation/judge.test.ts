import { describe, expect, it } from 'vitest'
import { type DelegationInput, FAILURE_GRACE_MS, judgeDelegation } from './judge'
import type { ResolverView } from './resolvers'

/**
 * FR-D5: what the resolvers' answers mean. The failure paths first — a
 * domain is only "not working" when every resolver agrees it is, and not in
 * the day after a change, while resolvers still hold the old delegation.
 */

const OURS = ['ns1.vercel-dns.com', 'ns2.vercel-dns.com']
const OLD = ['ns1.domainnameapi.com', 'ns2.domainnameapi.com']
const NOW = new Date('2026-09-28T12:00:00Z')
const LONG_AGO = new Date('2026-09-01T12:00:00Z')

const answered = (resolver: string, nameservers: string[]): ResolverView => ({
  resolver,
  state: 'answered',
  nameservers,
})
const state = (resolver: string, value: 'nxdomain' | 'servfail' | 'no-answer'): ResolverView => ({
  resolver,
  state: value,
})

const judge = (views: ResolverView[], over: Partial<DelegationInput> = {}) =>
  judgeDelegation({
    nameservers: OURS,
    current: 'pending',
    views,
    changedAt: LONG_AGO,
    now: NOW,
    ...over,
  })

describe('judgeDelegation', () => {
  it('fails a domain every resolver sees on other nameservers', () => {
    expect(judge([answered('Cloudflare', OLD), answered('Google', OLD)])).toBe('failed')
  })

  it('fails a domain that does not exist in DNS', () => {
    expect(judge([state('Cloudflare', 'nxdomain'), state('Google', 'nxdomain')])).toBe('failed')
  })

  it('fails a domain whose nameservers do not answer for it', () => {
    expect(judge([state('Cloudflare', 'servfail'), state('Google', 'servfail')])).toBe('failed')
  })

  it('fails a domain with no NS records at all', () => {
    expect(judge([answered('Cloudflare', []), answered('Google', [])])).toBe('failed')
  })

  it('waits two days after a change before calling it failed: .com delegations live 48 hours', () => {
    expect(FAILURE_GRACE_MS).toBe(48 * 3_600_000)
    const justChanged = new Date(NOW.getTime() - 2 * 3_600_000)
    expect(
      judge([answered('Cloudflare', OLD), answered('Google', OLD)], { changedAt: justChanged }),
    ).toBe('pending')
    const thirtyHoursAgo = new Date(NOW.getTime() - 30 * 3_600_000)
    expect(
      judge([answered('Cloudflare', OLD), answered('Google', OLD)], { changedAt: thirtyHoursAgo }),
    ).toBe('pending')
    const twoDaysAgo = new Date(NOW.getTime() - FAILURE_GRACE_MS)
    expect(
      judge([answered('Cloudflare', OLD), answered('Google', OLD)], { changedAt: twoDaysAgo }),
    ).toBe('failed')
  })

  it('fails without waiting when it does not know of any change', () => {
    expect(
      judge([state('Cloudflare', 'nxdomain'), state('Google', 'nxdomain')], { changedAt: null }),
    ).toBe('failed')
  })

  it('keeps a domain pending while resolvers disagree with each other', () => {
    expect(judge([answered('Cloudflare', OURS), answered('Google', OLD)])).toBe('pending')
    expect(judge([answered('Cloudflare', OLD), state('Google', 'nxdomain')])).toBe('pending')
    expect(judge([state('Cloudflare', 'servfail'), state('Google', 'nxdomain')])).toBe('pending')
    expect(
      judge([
        answered('Cloudflare', OLD),
        answered('Google', ['ns1.other.test', 'ns2.other.test']),
      ]),
    ).toBe('pending')
  })

  it('verifies a domain every resolver sees on our nameservers, however they are written', () => {
    expect(judge([answered('Cloudflare', OURS), answered('Google', OURS)])).toBe('verified')
    expect(
      judge([answered('Cloudflare', ['ns2.vercel-dns.com', 'ns1.vercel-dns.com'])], {
        nameservers: ['NS1.Vercel-DNS.com.', 'ns2.vercel-dns.com'],
      }),
    ).toBe('verified')
  })

  it('does not verify a partial match', () => {
    expect(
      judge([
        answered('Cloudflare', ['ns1.vercel-dns.com']),
        answered('Google', ['ns1.vercel-dns.com']),
      ]),
    ).toBe('failed')
  })

  it.each(['verified', 'failed', 'pending'] as const)(
    'leaves a %s domain as it was when a resolver could not be asked',
    (current) => {
      expect(judge([answered('Cloudflare', OLD), state('Google', 'no-answer')], { current })).toBe(
        current,
      )
      expect(judge([], { current })).toBe(current)
    },
  )
})
