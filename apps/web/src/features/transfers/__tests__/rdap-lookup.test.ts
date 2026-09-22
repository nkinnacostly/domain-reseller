import { HttpResponse, http } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { server } from '../../../../tests/mocks/server'

vi.mock('next/cache', () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }))

const { lookupDomain } = await import('../queries/rdap-lookup')

describe('lookupDomain', () => {
  it('reads the record from the registry that the bootstrap names', async () => {
    const result = await lookupDomain('getpaid.com')
    expect(result.kind).toBe('found')
    if (result.kind === 'found') expect(result.record.registrar).toBe('Example Registrar Ltd')
  })

  it('reports a name the registry has never heard of as not registered', async () => {
    server.use(
      http.get('https://rdap.test/verisign/domain/:name', () =>
        HttpResponse.json({ errorCode: 404, title: 'Not Found' }, { status: 404 }),
      ),
    )
    expect(await lookupDomain('nobody-has-this.com')).toEqual({ kind: 'not-found' })
  })

  it('does not call any registry for an extension without RDAP', async () => {
    const registry = vi.fn()
    server.events.on('request:start', registry)
    expect(await lookupDomain('getpaid.co')).toEqual({ kind: 'unsupported' })
    expect(
      registry.mock.calls.some(([{ request }]) => new URL(request.url).host === 'rdap.test'),
    ).toBe(false)
    server.events.removeAllListeners()
  })

  it('asks the HTTPS endpoint even when a plain-HTTP one is listed first', async () => {
    const pir = vi.fn(() => HttpResponse.json({ status: ['active'] }))
    server.use(http.get('https://rdap.test/pir/domain/:name', pir))
    expect((await lookupDomain('getpaid.org')).kind).toBe('found')
    expect(pir).toHaveBeenCalledOnce()
  })

  it('says the registry is unavailable when it errors', async () => {
    server.use(
      http.get(
        'https://rdap.test/verisign/domain/:name',
        () => new HttpResponse(null, { status: 503 }),
      ),
    )
    expect(await lookupDomain('getpaid.com')).toEqual({ kind: 'unavailable' })
  })

  it('says the registry is unavailable when the connection fails', async () => {
    server.use(http.get('https://rdap.test/verisign/domain/:name', () => HttpResponse.error()))
    expect(await lookupDomain('getpaid.com')).toEqual({ kind: 'unavailable' })
  })

  it('says the registry is unavailable when the answer is not a domain record', async () => {
    server.use(http.get('https://rdap.test/verisign/domain/:name', () => HttpResponse.json('oops')))
    expect(await lookupDomain('getpaid.com')).toEqual({ kind: 'unavailable' })
  })

  it('says the registry is unavailable when IANA cannot be reached', async () => {
    server.use(
      http.get(
        'https://data.iana.org/rdap/dns.json',
        () => new HttpResponse(null, { status: 500 }),
      ),
    )
    expect(await lookupDomain('getpaid.com')).toEqual({ kind: 'unavailable' })
  })
})
