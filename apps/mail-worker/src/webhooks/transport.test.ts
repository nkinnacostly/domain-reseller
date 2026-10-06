import type { LookupAddress } from 'node:dns'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createTransport, failureCode, publicOnlyLookup, type Transport } from './transport'

/**
 * The delivery transport (MAIL-SPEC §6): never a private address, by name or
 * by literal; 10 seconds at most; a short, printable answer kept. No test
 * reaches the internet: the "endpoint" is a local server reached through a
 * lookup that only tests may pass.
 */

type Resolved = { error?: NodeJS.ErrnoException; addresses?: LookupAddress[] }

function lookupWith(resolved: Resolved, all = false) {
  const lookup = publicOnlyLookup((_host, callback) =>
    callback(resolved.error ?? null, resolved.addresses ?? []),
  )
  return new Promise<{ error: NodeJS.ErrnoException | null; address: unknown; family?: number }>(
    (resolve) =>
      lookup(
        'hooks.acme.example',
        { all } as never,
        ((error: NodeJS.ErrnoException | null, address: unknown, family?: number) =>
          resolve({ error, address, family })) as never,
      ),
  )
}

describe('the public-only lookup', () => {
  it('answers the first public address, or all of them when asked', async () => {
    const addresses = [
      { address: '10.0.0.4', family: 4 },
      { address: '93.184.215.14', family: 4 },
      { address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c', family: 6 },
    ]
    expect(await lookupWith({ addresses })).toEqual({
      error: null,
      address: '93.184.215.14',
      family: 4,
    })
    expect((await lookupWith({ addresses }, true)).address).toEqual(addresses.slice(1))
  })

  it('refuses a name that resolves only to private addresses', async () => {
    const result = await lookupWith({
      addresses: [
        { address: '127.0.0.1', family: 4 },
        { address: '169.254.169.254', family: 4 },
        { address: '::1', family: 6 },
      ],
    })
    expect(result.error?.code).toBe('EPRIVATE')
    expect(failureCode(result.error)).toBe('private_address')
  })

  it('passes a resolver’s failure on', async () => {
    const error: NodeJS.ErrnoException = new Error('nope')
    error.code = 'ENOTFOUND'
    expect((await lookupWith({ error })).error).toBe(error)
  })
})

describe('failure codes', () => {
  it.each([
    ['ETIMEDOUT', 'timeout'],
    ['ENOTFOUND', 'dns_failed'],
    ['EAI_AGAIN', 'dns_failed'],
    ['CERT_HAS_EXPIRED', 'tls_failed'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls_failed'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls_failed'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls_failed'],
    ['ECONNREFUSED', 'connection_failed'],
    ['ECONNRESET', 'connection_failed'],
  ])('%s is %s', (code, expected) => {
    const error: NodeJS.ErrnoException = new Error(code)
    error.code = code
    expect(failureCode(error)).toBe(expected)
  })

  it('anything without a code is a connection that failed', () => {
    expect(failureCode(new Error('x'))).toBe('connection_failed')
    expect(failureCode(undefined)).toBe('connection_failed')
  })
})

describe('posting a delivery', () => {
  let server: Server | null = null
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    server = null
  })

  async function endpoint(handler: Parameters<typeof createServer>[1]): Promise<string> {
    server = createServer(handler)
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
    return `http://hooks.acme.example:${(server.address() as AddressInfo).port}/in`
  }

  /** A local stand-in: plain http, its name resolved to the local server. */
  const local = (timeoutMs?: number): Transport =>
    createTransport({
      request: httpRequest as never,
      allowHttp: true,
      lookup: ((
        _host: string,
        options: { all?: boolean },
        callback: (...args: unknown[]) => void,
      ) =>
        options.all
          ? callback(null, [{ address: '127.0.0.1', family: 4 }])
          : callback(null, '127.0.0.1', 4)) as never,
      ...(timeoutMs ? { timeoutMs } : {}),
    })

  it('POSTs the body with its headers and keeps the status and the start of the answer', async () => {
    let seen: { method?: string; headers?: Record<string, unknown>; body?: string } = {}
    const url = await endpoint((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        seen = { method: req.method, headers: req.headers, body }
        res.writeHead(202).end(`accepted\u0000${'x'.repeat(3000)}`)
      })
    })
    const result = await local()({
      url,
      headers: { 'content-type': 'application/json', 'webhook-id': 'msg_1' },
      body: '{"type":"email.delivered"}',
    })
    expect(result.status).toBe(202)
    expect(result.error).toBeNull()
    expect(result.response?.startsWith('accepted')).toBe(true)
    expect(result.response?.length).toBe(500)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(seen).toMatchObject({
      method: 'POST',
      headers: { 'webhook-id': 'msg_1', 'content-length': '26' },
      body: '{"type":"email.delivered"}',
    })
  })

  it('follows no redirect: a 3xx is the answer', async () => {
    const url = await endpoint((_req, res) => {
      res.writeHead(302, { location: 'http://127.0.0.1/elsewhere' }).end()
    })
    expect(await local()({ url, headers: {}, body: '{}' })).toMatchObject({
      status: 302,
      response: null,
    })
  })

  it('gives up after its time, with a code', async () => {
    const url = await endpoint(() => {
      // never answers
    })
    expect(await local(50)({ url, headers: {}, body: '{}' })).toMatchObject({
      status: null,
      error: 'timeout',
    })
  })

  it('reports a connection that failed', async () => {
    const url = await endpoint((req) => req.socket.destroy())
    expect(await local()({ url, headers: {}, body: '{}' })).toMatchObject({
      status: null,
      error: 'connection_failed',
    })
  })

  it('never connects to a private address written as a literal, or to anything but https', async () => {
    const transport = createTransport()
    for (const url of [
      'https://127.0.0.1/in',
      'https://10.1.2.3/in',
      'https://[::1]/in',
      'https://169.254.169.254/latest',
    ]) {
      expect(await transport({ url, headers: {}, body: '{}' })).toMatchObject({
        status: null,
        error: 'private_address',
      })
    }
    expect(
      await transport({ url: 'http://hooks.acme.example/in', headers: {}, body: '{}' }),
    ).toMatchObject({ error: 'connection_failed' })
    expect(await transport({ url: 'not a url', headers: {}, body: '{}' })).toMatchObject({
      error: 'connection_failed',
    })
  })

  it('refuses, before connecting, a name that resolves only to private addresses', async () => {
    const transport = createTransport({
      lookup: publicOnlyLookup((_host, callback) =>
        callback(null, [{ address: '192.168.1.20', family: 4 }]),
      ),
    })
    expect(
      await transport({ url: 'https://rebound.acme.example/in', headers: {}, body: '{}' }),
    ).toMatchObject({ status: null, error: 'private_address' })
  })
})
