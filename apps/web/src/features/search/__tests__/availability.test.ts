import { HttpResponse, http } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { server } from '../../../../tests/mocks/server'

vi.mock('@/lib/env', () => ({
  requireGatewayEnv: () => ({ url: 'http://gateway.test', sharedSecret: 'test-secret-value-16' }),
  env: { LOG_LEVEL: 'silent' },
}))

const { checkAvailability } = await import('../queries/availability')

describe('checkAvailability', () => {
  it('asks the gateway, never the supplier, with the shared secret (N1)', async () => {
    const seen = vi.fn()
    server.use(
      http.post('http://gateway.test/v1/availability', async ({ request }) => {
        seen(request.headers.get('authorization'), await request.json())
        return HttpResponse.json({
          ok: true,
          data: {
            results: [{ name: 'getpaid', tld: 'com', domain: 'getpaid.com', status: 'registered' }],
          },
        })
      }),
    )

    const outcome = await checkAvailability(['getpaid'], ['com'], 'high')

    expect(seen).toHaveBeenCalledWith('Bearer test-secret-value-16', {
      names: ['getpaid'],
      tlds: ['com'],
      priority: 'high',
    })
    expect(outcome).toEqual({
      ok: true,
      results: [{ name: 'getpaid', tld: 'com', domain: 'getpaid.com', status: 'registered' }],
    })
  })

  it('reports a rate limit distinctly, so the page can say "try again in a few seconds"', async () => {
    server.use(
      http.post('http://gateway.test/v1/availability', () =>
        HttpResponse.json(
          { ok: false, code: 'RATE_LIMITED', message: 'busy', retryable: true },
          { status: 429 },
        ),
      ),
    )
    expect(await checkAvailability(['busy'], ['com'])).toEqual({
      ok: false,
      reason: 'rate-limited',
    })
  })

  it('reports an outage as unavailable', async () => {
    server.use(
      http.post('http://gateway.test/v1/availability', () =>
        HttpResponse.json(
          { ok: false, code: 'SUPPLIER_AUTH', message: 'bad', retryable: false },
          { status: 502 },
        ),
      ),
    )
    expect(await checkAvailability(['down'], ['com'])).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('reports an unreachable gateway as unavailable', async () => {
    server.use(http.post('http://gateway.test/v1/availability', () => HttpResponse.error()))
    expect(await checkAvailability(['offline'], ['com'])).toEqual({
      ok: false,
      reason: 'unavailable',
    })
  })

  it('refuses an answer in a shape it does not recognise', async () => {
    server.use(
      http.post('http://gateway.test/v1/availability', () =>
        HttpResponse.json({ ok: true, data: { results: [{ domain: 'x.com', status: 'maybe' }] } }),
      ),
    )
    expect(await checkAvailability(['weird'], ['com'])).toEqual({
      ok: false,
      reason: 'unavailable',
    })
  })
})
