import { describe, expect, it, vi } from 'vitest'
import { combine, createAddressLookup, readAddresses } from './resolvers'

/**
 * Whether a preset's nameserver has an address, read from the resolvers'
 * DNS-over-HTTPS JSON (FR-D2). No real DNS: the answers are the shapes
 * Cloudflare and Google return.
 */

const a = (name: string, data: string) => ({ name, type: 1, TTL: 300, data })
const aaaa = (name: string, data: string) => ({ name, type: 28, TTL: 300, data })

describe('reading an A or AAAA answer', () => {
  it('cannot read something that is not an answer', () => {
    expect(readAddresses('A', null)).toEqual({ state: 'no-answer' })
    expect(readAddresses('A', 'NOERROR')).toEqual({ state: 'no-answer' })
    expect(readAddresses('A', { Status: 5 })).toEqual({ state: 'no-answer' })
  })

  it('knows a name that does not exist, and a provider that did not answer', () => {
    expect(readAddresses('A', { Status: 3 })).toEqual({ state: 'nxdomain' })
    expect(readAddresses('AAAA', { Status: 2 })).toEqual({ state: 'servfail' })
  })

  it('reads the addresses of the type asked for, once each', () => {
    expect(
      readAddresses('A', {
        Status: 0,
        Answer: [
          a('ns1.vercel-dns.com.', '216.150.1.1'),
          a('ns1.vercel-dns.com.', '216.150.1.1'),
          aaaa('ns1.vercel-dns.com.', '2001:db8::1'),
          null,
          { type: 1 },
        ],
      }),
    ).toEqual({ state: 'records', addresses: ['216.150.1.1'] })
    expect(
      readAddresses('AAAA', { Status: 0, Answer: [aaaa('ns1.host.test.', '2001:DB8::1')] }),
    ).toEqual({ state: 'records', addresses: ['2001:db8::1'] })
  })

  it('follows a CNAME to the target’s addresses', () => {
    expect(
      readAddresses('A', {
        Status: 0,
        Answer: [
          { name: 'ns1.host.test.', type: 5, data: 'dns.host.test.' },
          a('dns.host.test.', '192.0.2.1'),
        ],
      }),
    ).toEqual({ state: 'records', addresses: ['192.0.2.1'] })
  })

  it('reads an answer with no addresses as no data', () => {
    expect(readAddresses('A', { Status: 0 })).toEqual({ state: 'nodata' })
    expect(
      readAddresses('A', { Status: 0, Answer: [{ name: 'x.', type: 5, data: 'y.' }] }),
    ).toEqual({ state: 'nodata' })
  })
})

describe('one resolver’s view of a host', () => {
  const records = { state: 'records' as const, addresses: ['192.0.2.1'] }

  it('resolves with an address of either kind, whatever the other query said', () => {
    expect(combine('Google', records, { state: 'no-answer' })).toEqual({
      resolver: 'Google',
      state: 'resolves',
      addresses: ['192.0.2.1'],
    })
    expect(
      combine('Google', { state: 'nodata' }, { state: 'records', addresses: ['2001:db8::1'] }),
    ).toMatchObject({ state: 'resolves', addresses: ['2001:db8::1'] })
  })

  it('has no such name when either query says so', () => {
    expect(combine('Google', { state: 'no-answer' }, { state: 'nxdomain' })).toEqual({
      resolver: 'Google',
      state: 'nxdomain',
    })
  })

  it('says no address only when both queries were answered', () => {
    expect(combine('Google', { state: 'nodata' }, { state: 'nodata' }).state).toBe('no-address')
    expect(combine('Google', { state: 'nodata' }, { state: 'servfail' }).state).toBe('no-address')
    expect(combine('Google', { state: 'servfail' }, { state: 'servfail' }).state).toBe('servfail')
    // An IPv4 answer alone cannot rule out an IPv6-only host.
    expect(combine('Google', { state: 'nodata' }, { state: 'no-answer' }).state).toBe('no-answer')
  })
})

describe('asking the public resolvers', () => {
  it('asks each resolver for A and AAAA records of the host, in its DNS form', async () => {
    const asked: string[] = []
    const fetchImpl = vi.fn(async (url: URL | string) => {
      const target = new URL(String(url))
      asked.push(
        `${target.host} ${target.searchParams.get('name')} ${target.searchParams.get('type')}`,
      )
      return Response.json(
        target.searchParams.get('type') === 'A'
          ? { Status: 0, Answer: [a('ns1.host.test.', '192.0.2.1')] }
          : { Status: 0 },
      )
    })
    const lookup = createAddressLookup({ fetchImpl: fetchImpl as never })
    await expect(lookup('NS1.Host.Test.')).resolves.toEqual([
      { resolver: 'Cloudflare', state: 'resolves', addresses: ['192.0.2.1'] },
      { resolver: 'Google', state: 'resolves', addresses: ['192.0.2.1'] },
    ])
    expect(asked.sort()).toEqual([
      'cloudflare-dns.com ns1.host.test A',
      'cloudflare-dns.com ns1.host.test AAAA',
      'dns.google ns1.host.test A',
      'dns.google ns1.host.test AAAA',
    ])
  })

  it('treats a refused request or a network failure as no answer, never as no address', async () => {
    const fetchImpl = vi.fn(async (url: URL | string) => {
      if (new URL(String(url)).host === 'dns.google') throw new TypeError('fetch failed')
      return new Response('busy', { status: 503 })
    })
    const lookup = createAddressLookup({ fetchImpl: fetchImpl as never })
    await expect(lookup('ns1.host.test')).resolves.toEqual([
      { resolver: 'Cloudflare', state: 'no-answer' },
      { resolver: 'Google', state: 'no-answer' },
    ])
  })

  it('gives up on a slow resolver after its timeout', async () => {
    const fetchImpl = vi.fn(
      (_url: URL | string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
    )
    const lookup = createAddressLookup({
      fetchImpl: fetchImpl as never,
      resolvers: [{ name: 'Slow', url: 'https://slow.test/resolve' }],
      timeoutMs: 5,
    })
    await expect(lookup('ns1.host.test')).resolves.toEqual([
      { resolver: 'Slow', state: 'no-answer' },
    ])
  })

  it('reads a missing host as missing from each resolver that says so', async () => {
    const lookup = createAddressLookup({
      fetchImpl: (async () => Response.json({ Status: 3 })) as never,
    })
    await expect(lookup('ns9.gone.test')).resolves.toEqual([
      { resolver: 'Cloudflare', state: 'nxdomain' },
      { resolver: 'Google', state: 'nxdomain' },
    ])
  })
})
