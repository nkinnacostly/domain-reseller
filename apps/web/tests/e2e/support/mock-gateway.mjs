/**
 * A stand-in registrar gateway for Playwright (N12: tests never touch the
 * live supplier). Speaks the real contract from @dr/shared/availability, with
 * fixed answers so every run sees the same results:
 *
 *   takenbrand, google   → registered (exact name only — affixed ones are free)
 *   hotel                → premium
 *   x                    → restricted
 *   flakycheck on .app   → unknown
 *   xn--* on .app        → restricted (an extension refusing international names)
 *   allgone*             → every name registered, so no alternatives
 *   gatewaydown          → the whole request fails (502)
 *   busysearch           → rate limited (429)
 *   anything else        → available
 *
 * It also stands in for Flutterwave (under /flw): the payments API, a hosted
 * checkout page with "Pay (test)" and "Cancel", and transaction verification —
 * plus GET /v1/account/balance, reporting an empty float like the real one.
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.MOCK_GATEWAY_PORT ?? 8788)
const TAKEN = new Set(['takenbrand', 'google'])

function statusFor(name, tld) {
  if (TAKEN.has(name) || name.includes('allgone')) return 'registered'
  if (name === 'hotel') return 'premium'
  if (name === 'x') return 'restricted'
  if (name === 'flakycheck' && tld === 'app') return 'unknown'
  if (name.startsWith('xn--') && tld === 'app') return 'restricted'
  return 'available'
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Mock Flutterwave: payments created by the app, keyed by transaction id. */
const payments = new Map()
let nextTransactionId = 900001

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}))
  })
}

async function flutterwave(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)

  // The hosted checkout page the customer is sent to.
  const page = url.pathname.match(/^\/flw\/pay\/(\d+)$/)
  if (page) {
    const payment = payments.get(Number(page[1]))
    if (!payment) return send(res, 404, { status: 'error' })
    const back = (status) => {
      const target = new URL(payment.redirect_url)
      target.searchParams.set('status', status)
      target.searchParams.set('tx_ref', payment.tx_ref)
      if (status === 'successful') target.searchParams.set('transaction_id', String(payment.id))
      return target.toString()
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    return res.end(
      `<!doctype html><title>Mock Flutterwave</title><main><h1>Mock Flutterwave</h1>` +
        `<p>Pay NGN ${payment.amount} for ${payment.tx_ref}</p>` +
        `<a href="${back('successful')}">Pay (test)</a> <a href="${back('cancelled')}">Cancel</a></main>`,
    )
  }

  // N12 in the mock too: only test keys are accepted.
  if (!req.headers.authorization?.includes('_TEST-')) {
    return send(res, 401, { status: 'error', message: 'Test keys only' })
  }

  if (req.method === 'POST' && url.pathname === '/flw/v3/payments') {
    const body = await readBody(req)
    const id = nextTransactionId++
    payments.set(id, { ...body, id })
    return send(res, 200, {
      status: 'success',
      data: { link: `http://${req.headers.host}/flw/pay/${id}` },
    })
  }

  const verify = url.pathname.match(/^\/flw\/v3\/transactions\/(\d+)\/verify$/)
  if (req.method === 'GET' && verify) {
    const payment = payments.get(Number(verify[1]))
    if (!payment) return send(res, 404, { status: 'error', message: 'No transaction' })
    return send(res, 200, {
      status: 'success',
      data: {
        id: payment.id,
        tx_ref: payment.tx_ref,
        status: 'successful',
        amount: payment.amount,
        currency: payment.currency,
        payment_type: 'card',
      },
    })
  }

  return send(res, 404, { status: 'error' })
}

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, data: { status: 'healthy' } })
  }
  if (req.url?.startsWith('/flw/')) return void flutterwave(req, res)
  if (req.method === 'GET' && req.url === '/v1/account/balance') {
    // Like the real account today: an empty float, so test mode records a shortfall.
    return send(res, 200, { ok: true, data: { balanceUsd: 0 } })
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
