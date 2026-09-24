import { HttpResponse, http } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { server } from '../../../../tests/mocks/server'

vi.mock('next/cache', () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const { logger } = await import('@/lib/logger')
const { lookupWhois } = await import('../queries/whois')

describe('lookupWhois', () => {
  it('reads the record, nameservers included, and says when it asked', async () => {
    server.use(
      http.get('https://rdap.test/verisign/domain/:name', () =>
        HttpResponse.json({
          status: ['active'],
          nameservers: [{ ldhName: 'NS1.EXAMPLE-DNS.NET' }],
        }),
      ),
    )

    const answer = await lookupWhois('getpaid.com')

    expect(answer.lookup).toMatchObject({
      kind: 'found',
      record: { statuses: ['active'], nameservers: ['ns1.example-dns.net'] },
    })
    expect(answer.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('reports a name the registry has no record of', async () => {
    server.use(
      http.get(
        'https://rdap.test/verisign/domain/:name',
        () => new HttpResponse(null, { status: 404 }),
      ),
    )
    expect((await lookupWhois('nobody-has-this.com')).lookup).toEqual({ kind: 'not-found' })
  })

  it('reports an extension without RDAP as unsupported', async () => {
    expect((await lookupWhois('getpaid.co')).lookup).toEqual({ kind: 'unsupported' })
  })

  it('says the registry did not answer, and logs the extension but never the name', async () => {
    server.use(
      http.get(
        'https://rdap.test/verisign/domain/:name',
        () => new HttpResponse(null, { status: 503 }),
      ),
    )

    expect(await lookupWhois('secret-plans.com')).toEqual({
      lookup: { kind: 'unavailable' },
      checkedAt: null,
    })
    const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls)
    expect(logged).toContain('"tld":"com"')
    expect(logged).not.toContain('secret-plans')
  })
})
