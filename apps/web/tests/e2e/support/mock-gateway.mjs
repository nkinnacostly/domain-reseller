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
 *
 * And for the registries' RDAP servers (under /rdap), so transfer checks and
 * WHOIS lookups never wait on a live registry — Verisign has taken over 10 s.
 * RDAP_BOOTSTRAP_URL points the app at /rdap/dns.json, which lists .com, .net
 * and .org here and, like IANA's real file, has no .co:
 *
 *   lockedbrand.com   → registered, locked by its registrar and the registry
 *   readytomove.com   → registered years ago, unlocked: ready to transfer
 *   brandnew.com      → registered 10 days ago, inside the 60-day window
 *   registrydown.com  → the registry fails (503)
 *   anything else     → not registered (404)
 *
 * Registered answers carry a registrant with personal details, as some
 * registries still publish — the pages must never show them.
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

/** Mock RDAP (RFC 9083): IANA's bootstrap file and one registry per extension. */
const DAY_MS = 86_400_000
const RDAP_REGISTERED = {
  lockedbrand: {
    status: [
      'client delete prohibited',
      'client transfer prohibited',
      'client update prohibited',
      'server transfer prohibited',
    ],
    registeredAt: () => '2010-04-12T09:30:00Z',
    expiresAt: () => '2031-04-12T09:30:00Z',
  },
  readytomove: {
    status: ['active'],
    registeredAt: () => '2015-03-01T10:00:00Z',
    expiresAt: () => '2027-03-01T10:00:00Z',
  },
  brandnew: {
    status: ['active'],
    registeredAt: () => new Date(Date.now() - 10 * DAY_MS).toISOString(),
    expiresAt: () => new Date(Date.now() + 355 * DAY_MS).toISOString(),
  },
}

function rdap(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  if (url.pathname === '/rdap/dns.json') {
    const base = `http://127.0.0.1:${PORT}/rdap`
    return send(res, 200, {
      version: '1.0',
      publication: '2026-09-24T00:00:00Z',
      services: [
        [['com', 'net'], [`${base}/verisign/`]],
        [['org'], [`${base}/pir/`]],
      ],
    })
  }

  const match = url.pathname.match(/^\/rdap\/[a-z]+\/domain\/([^/]+)$/)
  if (!match) return send(res, 404, { errorCode: 404, title: 'Not Found' })

  const domain = decodeURIComponent(match[1]).toLowerCase()
  const [name] = domain.split('.')
  if (name === 'registrydown') return send(res, 503, { errorCode: 503, title: 'Unavailable' })

  const fixture = RDAP_REGISTERED[name]
  if (!fixture) return send(res, 404, { errorCode: 404, title: 'Not Found' })

  return send(res, 200, {
    objectClassName: 'domain',
    ldhName: domain.toUpperCase(),
    status: fixture.status,
    events: [
      { eventAction: 'registration', eventDate: fixture.registeredAt() },
      { eventAction: 'expiration', eventDate: fixture.expiresAt() },
      { eventAction: 'last changed', eventDate: '2026-01-05T08:00:00Z' },
    ],
    entities: [
      {
        objectClassName: 'entity',
        roles: ['registrar'],
        vcardArray: [
          'vcard',
          [
            ['version', {}, 'text', '4.0'],
            ['fn', {}, 'text', 'Example Registrar, Inc.'],
          ],
        ],
      },
      {
        objectClassName: 'entity',
        roles: ['registrant'],
        vcardArray: [
          'vcard',
          [
            ['version', {}, 'text', '4.0'],
            ['fn', {}, 'text', 'Adaeze Placeholder'],
            ['email', {}, 'text', 'adaeze.placeholder@example.net'],
            ['tel', {}, 'uri', 'tel:+234-800-000-0000'],
          ],
        ],
      },
    ],
    nameservers: [
      { objectClassName: 'nameserver', ldhName: 'NS1.EXAMPLE-DNS.NET' },
      { objectClassName: 'nameserver', ldhName: 'NS2.EXAMPLE-DNS.NET' },
    ],
  })
}

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, data: { status: 'healthy' } })
  }
  if (req.url?.startsWith('/flw/')) return void flutterwave(req, res)
  if (req.method === 'GET' && req.url?.startsWith('/rdap/')) return rdap(req, res)
  if (req.method === 'GET' && req.url === '/v1/account/balance') {
    // Like the real account today: an empty float, so test mode records a shortfall.
    return send(res, 200, { ok: true, data: { balanceUsd: 0 } })
  }
  // A domain's transfer code (FR-DS5): a fixed code per side; `nocode*` names have none.
  const transferCode = req.url?.match(/^\/v1\/domains\/([^/?]+)\/auth-code\?side=(sandbox|live)$/)
  if (req.method === 'GET' && transferCode) {
    if (!req.headers.authorization?.startsWith('Bearer ')) {
      return send(res, 401, { ok: false, code: 'SUPPLIER_AUTH', message: 'Unauthorised' })
    }
    if (transferCode[1].startsWith('nocode')) {
      return send(res, 502, {
        ok: false,
        code: 'AUTH_CODE_UNAVAILABLE',
        message: 'The registry gave no transfer code for this domain',
        retryable: false,
      })
    }
    const side = transferCode[2] === 'sandbox' ? 'OTE' : 'LIVE'
    return send(res, 200, { ok: true, data: { authCode: `E2E-${side}-7qX!code` } })
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
