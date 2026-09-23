import type { DnaHttpRequest } from 'nodejs-dna'
import { describe, expect, it, vi } from 'vitest'
import { createTransport, withExchanges } from './transport'

const request = (over: Partial<DnaHttpRequest> = {}): DnaHttpRequest => ({
  method: 'GET',
  url: 'https://ote.example.test/api/v1/domains/info',
  headers: { 'X-API-KEY': 'key', 'Content-Type': 'application/json' },
  timeout: 1_000,
  ...over,
})

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('createTransport', () => {
  it('sends query parameters on a read and a JSON body on a write', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      json(200, {}),
    )
    const send = createTransport(fetchImpl as typeof fetch)

    await send(request({ params: { DomainName: 'example.com' } }))
    await send(
      request({ method: 'post', url: 'https://ote.example.test/api/v1/x', data: { a: 1 } }),
    )

    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'https://ote.example.test/api/v1/domains/info?DomainName=example.com',
    )
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBeUndefined()
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', body: '{"a":1}' })
  })

  it('does not follow redirects, which the SDK reads as bad credentials', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      json(200, {}),
    )
    await createTransport(fetchImpl as typeof fetch)(request())
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe('manual')
  })

  it('hands the SDK the status and parsed body, whatever the status', async () => {
    const send = createTransport((async () => json(404, { error: { code: 'X' } })) as typeof fetch)
    await expect(send(request())).resolves.toMatchObject({
      status: 404,
      data: { error: { code: 'X' } },
    })
  })

  it('keeps a body that is not JSON', async () => {
    const send = createTransport(
      (async () => new Response('Bad gateway', { status: 502 })) as typeof fetch,
    )
    await expect(send(request())).resolves.toMatchObject({
      status: 502,
      data: { raw_response: 'Bad gateway' },
    })
  })

  it('throws on a network failure, as the SDK expects, after recording it', async () => {
    const send = createTransport((async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError')
    }) as typeof fetch)

    const run = withExchanges(() => send(request()).catch(() => 'swallowed by the SDK'))
    const { result, exchanges } = await run

    expect(result).toBe('swallowed by the SDK')
    expect(exchanges).toEqual([
      expect.objectContaining({
        status: null,
        networkError: 'TIMEOUT',
        path: '/api/v1/domains/info',
      }),
    ])
  })

  it('records a refused connection by its code', async () => {
    const send = createTransport((async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
    }) as typeof fetch)
    const { exchanges } = await withExchanges(() => send(request()).catch(() => null))
    expect(exchanges[0]?.networkError).toBe('ECONNREFUSED')
  })
})

describe('withExchanges', () => {
  it('keeps each call’s exchanges apart when calls overlap', async () => {
    const send = createTransport((async (url: string | URL | Request) => {
      await new Promise((resolve) => setTimeout(resolve, String(url).includes('slow') ? 20 : 1))
      return json(200, { url: String(url) })
    }) as typeof fetch)

    const [slow, fast] = await Promise.all([
      withExchanges(() => send(request({ url: 'https://h.test/slow' }))),
      withExchanges(() => send(request({ url: 'https://h.test/fast' }))),
    ])

    expect(slow.exchanges.map((exchange) => exchange.path)).toEqual(['/slow'])
    expect(fast.exchanges.map((exchange) => exchange.path)).toEqual(['/fast'])
  })

  it('records nothing outside a scope', async () => {
    const send = createTransport((async () => json(200, {})) as typeof fetch)
    await expect(send(request())).resolves.toMatchObject({ status: 200 })
  })
})
