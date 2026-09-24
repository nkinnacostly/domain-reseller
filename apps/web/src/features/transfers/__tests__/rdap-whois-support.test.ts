import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { server } from '../../../../tests/mocks/server'
import { isTrustedEndpoint, parseBootstrap, parseRdapNameservers } from '../lib/rdap'

/**
 * What the RDAP client gained for the WHOIS page (FR-PUB2) and for e2e: a
 * caller-chosen parser, nameservers, and a bootstrap address e2e can point at
 * a local mock registry.
 */

vi.mock('next/cache', () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }))

describe('isTrustedEndpoint', () => {
  it('trusts HTTPS, and plain HTTP only on this machine', () => {
    expect(isTrustedEndpoint('https://rdap.verisign.com/com/v1/')).toBe(true)
    expect(isTrustedEndpoint('http://127.0.0.1:8805/rdap/verisign/')).toBe(true)
    expect(isTrustedEndpoint('http://localhost:8805/rdap/')).toBe(true)
    expect(isTrustedEndpoint('http://[::1]/rdap/')).toBe(true)

    expect(isTrustedEndpoint('http://rdap.example.com/')).toBe(false)
    // A host that merely starts like loopback is somewhere else.
    expect(isTrustedEndpoint('http://127.0.0.1.evil.test/')).toBe(false)
    expect(isTrustedEndpoint('http://localhost.evil.test/')).toBe(false)
  })

  it('lets the bootstrap list a local mock registry', () => {
    const table = parseBootstrap({
      services: [[['com'], ['http://127.0.0.1:8805/rdap/verisign/']]],
    })
    expect(table.com).toBe('http://127.0.0.1:8805/rdap/verisign/')
  })
})

describe('parseRdapNameservers', () => {
  it('reads the nameservers, lowercased, without a trailing dot, once each', () => {
    expect(
      parseRdapNameservers({
        nameservers: [
          { objectClassName: 'nameserver', ldhName: 'NS1.GOOGLE.COM' },
          { objectClassName: 'nameserver', ldhName: 'ns2.google.com.' },
          { objectClassName: 'nameserver', ldhName: 'ns1.google.com' },
        ],
      }),
    ).toEqual(['ns1.google.com', 'ns2.google.com'])
  })

  it('drops anything that is not a hostname', () => {
    expect(
      parseRdapNameservers({
        nameservers: [
          { ldhName: '<script>alert(1)</script>' },
          { ldhName: 'not a host' },
          {},
          { ldhName: 'ns.example.net' },
        ],
      }),
    ).toEqual(['ns.example.net'])
  })

  it('is empty when there are none, or the answer is unreadable', () => {
    expect(parseRdapNameservers({ objectClassName: 'domain' })).toEqual([])
    expect(parseRdapNameservers({ nameservers: 'nope' })).toEqual([])
    expect(parseRdapNameservers(null)).toEqual([])
  })
})

describe('lookupRdap', () => {
  it('hands the registry’s answer to the caller’s parser', async () => {
    const { lookupRdap } = await import('../queries/rdap-lookup')
    const parse = vi.fn((json: unknown) => ({ raw: json }))

    const result = await lookupRdap('getpaid.com', parse)

    expect(result.kind).toBe('found')
    expect(parse).toHaveBeenCalledOnce()
  })

  it('reports an answer the parser cannot read as unavailable', async () => {
    const { lookupRdap } = await import('../queries/rdap-lookup')
    expect(await lookupRdap('getpaid.com', () => null)).toEqual({ kind: 'unavailable' })
  })
})

describe('RDAP_BOOTSTRAP_URL', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('points every lookup at the bootstrap file it names, as e2e does', async () => {
    vi.resetModules()
    vi.stubEnv('RDAP_BOOTSTRAP_URL', 'http://127.0.0.1:9999/rdap/dns.json')
    const registry = vi.fn(() => HttpResponse.json({ status: ['active'] }))
    server.use(
      http.get('http://127.0.0.1:9999/rdap/dns.json', () =>
        HttpResponse.json({ services: [[['com'], ['http://127.0.0.1:9999/rdap/mock/']]] }),
      ),
      http.get('http://127.0.0.1:9999/rdap/mock/domain/:name', registry),
    )

    const { lookupDomain } = await import('../queries/rdap-lookup')

    expect((await lookupDomain('getpaid.com')).kind).toBe('found')
    expect(registry).toHaveBeenCalledOnce()
  })
})
