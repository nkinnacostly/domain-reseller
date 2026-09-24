import { describe, expect, it, vi } from 'vitest'
import { createNsLookup, normaliseHost, readAnswer } from './resolvers'

/**
 * What the public resolvers say, read from their DNS-over-HTTPS JSON. No real
 * DNS here: the answers are the shapes Cloudflare and Google return.
 */

const ns = (name: string, data: string) => ({ name, type: 2, TTL: 3600, data })

describe('reading a resolver’s answer', () => {
  it('cannot read something that is not an answer', () => {
    expect(readAnswer('Google', 'example.com', null)).toEqual({
      resolver: 'Google',
      state: 'no-answer',
    })
    expect(readAnswer('Google', 'example.com', 'SERVFAIL')).toEqual({
      resolver: 'Google',
      state: 'no-answer',
    })
  })

  it('knows a name that does not exist', () => {
    expect(readAnswer('Cloudflare', 'example.com', { Status: 3 })).toEqual({
      resolver: 'Cloudflare',
      state: 'nxdomain',
    })
  })

  it('knows when the domain’s own nameservers did not answer', () => {
    expect(readAnswer('Cloudflare', 'example.com', { Status: 2 })).toEqual({
      resolver: 'Cloudflare',
      state: 'servfail',
    })
  })

  it('treats any other failure as no answer', () => {
    expect(readAnswer('Cloudflare', 'example.com', { Status: 5 })).toEqual({
      resolver: 'Cloudflare',
      state: 'no-answer',
    })
  })

  it('reads the domain’s NS records, however they are written', () => {
    const view = readAnswer('Google', 'Example.com', {
      Status: 0,
      Answer: [
        ns('example.com.', 'NS2.Vercel-DNS.com.'),
        ns('EXAMPLE.COM', 'ns1.vercel-dns.com'),
        ns('example.com.', 'ns1.vercel-dns.com.'),
      ],
    })
    expect(view).toEqual({
      resolver: 'Google',
      state: 'answered',
      nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
    })
  })

  it('ignores records that are not the domain’s own NS', () => {
    const view = readAnswer('Google', 'www.example.com', {
      Status: 0,
      Answer: [
        { name: 'www.example.com.', type: 5, data: 'example.com.' },
        ns('example.com.', 'ns1.parent.test.'),
        null,
        { name: 'www.example.com.', type: 2 },
      ],
    })
    expect(view).toEqual({ resolver: 'Google', state: 'answered', nameservers: [] })
  })

  it('reads an empty answer as no nameservers at all', () => {
    expect(readAnswer('Google', 'example.com', { Status: 0 })).toEqual({
      resolver: 'Google',
      state: 'answered',
      nameservers: [],
    })
  })

  it('normalises a host name', () => {
    expect(normaliseHost(' NS1.Example.COM.. ')).toBe('ns1.example.com')
  })
})

describe('asking the public resolvers', () => {
  const answer = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/dns-json' },
    })

  it('asks Cloudflare and Google for the NS records, in the JSON form', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      answer({ Status: 0, Answer: [ns('example.com.', 'ns1.host.test.')] }),
    )
    const views = await createNsLookup({ fetchImpl })('example.com')
    expect(views).toEqual([
      { resolver: 'Cloudflare', state: 'answered', nameservers: ['ns1.host.test'] },
      { resolver: 'Google', state: 'answered', nameservers: ['ns1.host.test'] },
    ])
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      'https://cloudflare-dns.com/dns-query?name=example.com&type=NS',
      'https://dns.google/resolve?name=example.com&type=NS',
    ])
    const init = fetchImpl.mock.calls[0]?.[1]
    expect(init?.headers).toEqual({ accept: 'application/dns-json' })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('has no answer from a resolver that timed out, failed, or sent something unreadable', async () => {
    const replies = [
      () => Promise.reject(new DOMException('The operation was aborted', 'TimeoutError')),
      () => Promise.resolve(answer({}, 502)),
      () => Promise.resolve(new Response('<html>', { status: 200 })),
    ]
    const resolvers = replies.map((_, index) => ({
      name: `r${index}`,
      url: `https://r${index}.test/q`,
    }))
    let call = 0
    const fetchImpl = vi.fn(async () => (replies[call++] as () => Promise<Response>)())
    const views = await createNsLookup({ resolvers, fetchImpl: fetchImpl as never })('example.com')
    expect(views.map((view) => view.state)).toEqual(['no-answer', 'no-answer', 'no-answer'])
  })

  it('asks for an internationalised name in its ASCII form', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => answer({ Status: 3 }))
    await createNsLookup({
      fetchImpl,
      resolvers: [{ name: 'Google', url: 'https://dns.google/resolve' }],
    })('bücher.de')
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'https://dns.google/resolve?name=xn--bcher-kva.de&type=NS',
    )
  })

  it('asks for a name it cannot convert as it is', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => answer({ Status: 3 }))
    await createNsLookup({
      fetchImpl,
      resolvers: [{ name: 'Google', url: 'https://dns.google/resolve' }],
    })('xn--iñvalid.com')
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'https://dns.google/resolve?name=xn--i%C3%B1valid.com&type=NS',
    )
  })
})
