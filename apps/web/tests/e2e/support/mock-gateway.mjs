/**
 * A stand-in registrar gateway for Playwright (N12: tests never touch the
 * live supplier). Speaks the real contract from @dr/shared/availability, with
 * fixed answers so every run sees the same results:
 *
 *   takenbrand, google   → registered (exact name only — affixed ones are free)
 *   hotel                → premium
 *   x                    → restricted
 *   flakycheck on .app   → unknown
 *   allgone*             → every name registered, so no alternatives
 *   gatewaydown          → the whole request fails (502)
 *   busysearch           → rate limited (429)
 *   anything else        → available
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.MOCK_GATEWAY_PORT ?? 8788)
const TAKEN = new Set(['takenbrand', 'google'])

function statusFor(name, tld) {
  if (TAKEN.has(name) || name.includes('allgone')) return 'registered'
  if (name === 'hotel') return 'premium'
  if (name === 'x') return 'restricted'
  if (name === 'flakycheck' && tld === 'app') return 'unknown'
  return 'available'
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, data: { status: 'healthy' } })
  }
  if (req.method !== 'POST' || req.url !== '/v1/availability') {
    return send(res, 404, { ok: false, code: 'NOT_FOUND', message: 'Unknown route' })
  }
  if (!req.headers.authorization?.startsWith('Bearer ')) {
    return send(res, 401, { ok: false, code: 'SUPPLIER_AUTH', message: 'Unauthorised' })
  }

  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk
  })
  req.on('end', () => {
    const { names = [], tlds = [] } = JSON.parse(raw || '{}')
    if (names.includes('gatewaydown')) {
      return send(res, 502, {
        ok: false,
        code: 'SUPPLIER_UNAVAILABLE',
        message: 'Gateway error',
        retryable: true,
      })
    }
    if (names.includes('busysearch')) {
      return send(res, 429, {
        ok: false,
        code: 'RATE_LIMITED',
        message: 'Too many searches at once.',
        retryable: true,
      })
    }
    send(res, 200, {
      ok: true,
      data: {
        results: names.flatMap((name) =>
          tlds.map((tld) => ({
            name,
            tld,
            domain: `${name}.${tld}`,
            status: statusFor(name, tld),
          })),
        ),
      },
    })
  })
}).listen(PORT, '127.0.0.1', () => {
  console.log(`mock gateway on http://127.0.0.1:${PORT}`)
})
