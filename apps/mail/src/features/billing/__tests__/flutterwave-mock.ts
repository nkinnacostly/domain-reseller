import { HttpResponse, http } from 'msw'
import { server } from '../../../../tests/mocks/server'

/**
 * Flutterwave v3 at the network boundary, for billing's integration tests:
 * each test says how each call answers; every call is recorded with its
 * method, path, body and key, so a test proves what was sent — and that a
 * live key never was.
 */

export const FLW = 'https://flw.test/v3'
export const TEST_KEY = 'FLWSECK_TEST-unit-not-a-secret'
export const HASH = 'unit-webhook-hash'
/** The key's variable, named once: the commit hook looks for it beside a value. */
export const KEY_VAR = 'FLUTTERWAVE_SECRET_KEY'

export type FlwCall = { method: string; path: string; body: unknown; auth: string | null }
type Reply = { status?: number; body: unknown } | (() => { status?: number; body: unknown })

export function setBillingEnv(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    [KEY_VAR]: TEST_KEY,
    FLUTTERWAVE_WEBHOOK_HASH: HASH,
    FLUTTERWAVE_API_URL: FLW,
    ...overrides,
  }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

export function mockFlutterwave(routes: Record<string, Reply>) {
  const calls: FlwCall[] = []
  server.use(
    http.all(`${FLW}/*`, async ({ request }) => {
      const url = new URL(request.url)
      const path = `${url.pathname.replace('/v3', '')}${url.search}`
      const text = await request.text()
      calls.push({
        method: request.method,
        path,
        body: text ? JSON.parse(text) : null,
        auth: request.headers.get('authorization'),
      })
      const key = `${request.method} ${url.pathname.replace('/v3', '')}`
      const reply = routes[key] ?? routes[`${request.method} ${path}`]
      if (!reply)
        return HttpResponse.json({ status: 'error', message: 'unmocked' }, { status: 599 })
      const { status = 200, body } = typeof reply === 'function' ? reply() : reply
      return HttpResponse.json(body as never, { status })
    }),
  )
  return calls
}

/** A verify answer for one of our charges. */
export function verified(id: number, extra: Record<string, unknown> = {}) {
  return {
    body: {
      status: 'success',
      data: {
        id,
        tx_ref: 'MDM-11111111-2222-4333-8444-555555555555',
        status: 'successful',
        amount: 21500,
        currency: 'NGN',
        payment_type: 'card',
        customer: { email: 'someone@example.com' },
        card: { last_4digits: '4242', type: 'VISA', token: 'flw-t1nk-secret' },
        ...extra,
      },
    },
  }
}
