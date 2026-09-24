import { GatewayError } from '@dr/shared/errors'
import { HttpResponse, http } from 'msw'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { server } from '../../../tests/mocks/server'
import { callGateway } from '../gateway'

// env.ts reads process.env once, at import: point it at a test gateway first.
vi.hoisted(() => {
  vi.stubEnv('GATEWAY_URL', 'http://gateway.test')
  vi.stubEnv('GATEWAY_SHARED_SECRET', 'test-secret-value-16')
})
afterAll(() => vi.unstubAllEnvs())

const BASE = 'http://gateway.test/v1'

type Seen = { method: string; headers: Headers; body: string }

/** Records the request the gateway received, and answers with `reply`. */
function capture(path: string, reply: () => Response) {
  const seen: Seen[] = []
  server.use(
    http.all(`${BASE}/${path}`, async ({ request }) => {
      seen.push({ method: request.method, headers: request.headers, body: await request.text() })
      return reply()
    }),
  )
  return seen
}

/** The GatewayError a call fails with. */
async function failure(promise: Promise<unknown>): Promise<GatewayError> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  )
  expect(error).toBeInstanceOf(GatewayError)
  return error as GatewayError
}

describe('callGateway', () => {
  it('reads with a GET carrying the shared secret, and returns the data (N1)', async () => {
    const seen = capture('account/balance', () =>
      HttpResponse.json({ ok: true, data: { balance: 5000, currency: 'USD' } }),
    )

    const data = await callGateway<{ balance: number }>({ path: 'account/balance' })

    expect(data).toEqual({ balance: 5000, currency: 'USD' })
    expect(seen[0]?.method).toBe('GET')
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer test-secret-value-16')
    expect(seen[0]?.headers.get('idempotency-key')).toBeNull()
    expect(seen[0]?.body).toBe('')
  })

  it('posts a write as JSON with its idempotency key (N3)', async () => {
    const seen = capture('domains/register', () =>
      HttpResponse.json({ ok: true, data: { status: 'registered' } }),
    )

    await callGateway({
      path: '/domains/register',
      body: { domain: 'getpaid.com', years: 1 },
      idempotencyKey: 'order-1:line-1',
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.method).toBe('POST')
    expect(seen[0]?.headers.get('content-type')).toBe('application/json')
    expect(seen[0]?.headers.get('idempotency-key')).toBe('order-1:line-1')
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({ domain: 'getpaid.com', years: 1 })
  })

  it("passes the gateway's own error code and message through", async () => {
    capture('domains/register', () =>
      HttpResponse.json(
        { ok: false, code: 'SUPPLIER_INSUFFICIENT_FUNDS', message: 'Float too low' },
        { status: 402 },
      ),
    )

    const error = await failure(callGateway({ path: 'domains/register', body: {} }))

    expect(error.code).toBe('SUPPLIER_INSUFFICIENT_FUNDS')
    expect(error.message).toBe('Float too low')
    // Not retryable unless the gateway says so.
    expect(error.retryable).toBe(false)
  })

  it('keeps the retryable flag the gateway sends', async () => {
    capture('availability', () =>
      HttpResponse.json(
        { ok: false, code: 'RATE_LIMITED', message: 'busy', retryable: true },
        { status: 429 },
      ),
    )

    const error = await failure(callGateway({ path: 'availability', body: { names: [] } }))

    expect(error.code).toBe('RATE_LIMITED')
    expect(error.retryable).toBe(true)
  })

  it('treats an answer it cannot read as a retryable outage, not as success', async () => {
    capture('account/balance', () => new HttpResponse('<html>Bad gateway</html>', { status: 502 }))

    const error = await failure(callGateway({ path: 'account/balance' }))

    expect(error.code).toBe('SUPPLIER_UNAVAILABLE')
    expect(error.message).toBe('The registrar service failed.')
    expect(error.retryable).toBe(true)
  })

  it('treats an error status as a failure even when the body claims success', async () => {
    capture('account/balance', () =>
      HttpResponse.json({ ok: true, data: { balance: 5000 } }, { status: 500 }),
    )

    const error = await failure(callGateway({ path: 'account/balance' }))

    expect(error.code).toBe('SUPPLIER_UNAVAILABLE')
  })

  it('treats a 200 that is not JSON as a failure', async () => {
    capture('account/balance', () => new HttpResponse('ok', { status: 200 }))

    const error = await failure(callGateway({ path: 'account/balance' }))

    expect(error.code).toBe('SUPPLIER_UNAVAILABLE')
  })

  it('reports an unreachable gateway as retryable, keeping the cause', async () => {
    server.use(http.get(`${BASE}/account/balance`, () => HttpResponse.error()))

    const error = await failure(callGateway({ path: 'account/balance' }))

    expect(error.code).toBe('SUPPLIER_UNAVAILABLE')
    expect(error.message).toBe('The registrar service is unreachable.')
    expect(error.retryable).toBe(true)
    expect(error.cause).toBeDefined()
  })

  it('gives up when the caller aborts, rather than waiting on a slow gateway', async () => {
    const seen = capture('account/balance', () => HttpResponse.json({ ok: true, data: {} }))

    const error = await failure(
      callGateway({ path: 'account/balance', signal: AbortSignal.abort() }),
    )

    expect(error.code).toBe('SUPPLIER_UNAVAILABLE')
    expect(seen).toHaveLength(0)
  })
})
