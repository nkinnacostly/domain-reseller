/**
 * A stand-in Flutterwave for Mail's billing e2e (N12: no test ever reaches
 * Flutterwave). It speaks the v3 calls billing makes, with answers shaped as
 * Flutterwave documents them (features/billing/lib/flutterwave.ts names the
 * sources), and accepts test keys only:
 *
 *   POST /flw/v3/payment-plans             a monthly plan object
 *   POST /flw/v3/payments                  a hosted checkout; with `payment_plan`
 *                                          the card is subscribed on payment
 *   GET  /flw/pay/:id                      the hosted page: "Pay (test)", "Cancel"
 *   GET  /flw/v3/transactions/:id/verify   a charge, card digits and token included
 *                                          (the app must keep neither)
 *   GET  /flw/v3/subscriptions?transaction_id=
 *   PUT  /flw/v3/subscriptions/:id/cancel | /activate
 *
 * And one control for tests, standing in for Flutterwave's own renewal run:
 *
 *   POST /flw/test/renewal { customer_email, status }
 *     charges the customer's latest subscription again on its first charge's
 *     reference — successful or failed — and sends `charge.completed` to the
 *     app's webhook with the account's hash, as Paidly forwards it.
 *
 * Import nothing from here in a spec: importing it starts the server.
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.MOCK_FLUTTERWAVE_PORT ?? 4301)
const WEBHOOK_URL = process.env.MOCK_FLUTTERWAVE_WEBHOOK_URL ?? ''
const WEBHOOK_HASH = process.env.MOCK_FLUTTERWAVE_WEBHOOK_HASH ?? ''

const plans = new Map()
const checkouts = new Map()
const transactions = new Map()
const subscriptions = new Map()
let nextId = 9_100_001

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
  })
}

/** A charge as `GET /transactions/:id/verify` answers it, customer and card token included. */
function charge({ txRef, amount, status, email, plan }) {
  const id = nextId++
  const transaction = {
    id,
    tx_ref: txRef,
    flw_ref: `MOCK-FLW-${id}`,
    amount,
    charged_amount: amount,
    currency: 'NGN',
    status,
    payment_type: 'card',
    created_at: new Date().toISOString(),
    customer: { id: 1, name: 'E2E Customer', email, phone_number: '0800000000' },
    card: {
      first_6digits: '553188',
      last_4digits: '4242',
      issuer: 'MOCK BANK',
      country: 'NG',
      type: 'VISA',
      token: 'flw-t1nk-not-a-real-token',
      expiry: '09/32',
    },
    plan: plan ?? null,
  }
  transactions.set(id, transaction)
  return transaction
}

function page(res, checkout, id) {
  const cancel = new URL(checkout.redirect_url)
  cancel.searchParams.set('status', 'cancelled')
  cancel.searchParams.set('tx_ref', checkout.tx_ref)
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(
    `<!doctype html><html lang="en"><title>Mock Flutterwave</title><main><h1>Mock Flutterwave</h1>` +
      `<p>Pay NGN ${checkout.amount} for ${checkout.tx_ref}</p>` +
      `<a href="/flw/pay/${id}/complete">Pay (test)</a> <a href="${cancel}">Cancel</a></main></html>`,
  )
}

async function flutterwave(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const path = url.pathname

  const hosted = path.match(/^\/flw\/pay\/(\d+)(\/complete)?$/)
  if (req.method === 'GET' && hosted) {
    const checkout = checkouts.get(Number(hosted[1]))
    if (!checkout) return send(res, 404, { status: 'error', message: 'No such checkout' })
    if (!hosted[2]) return void page(res, checkout, hosted[1])
    // "Pay (test)": the card is charged, and subscribed when the payment named a plan.
    const transaction = charge({
      txRef: checkout.tx_ref,
      amount: checkout.amount,
      status: 'successful',
      email: checkout.customer?.email ?? '',
      plan: checkout.payment_plan,
    })
    if (checkout.payment_plan) {
      const plan = plans.get(checkout.payment_plan)
      const id = nextId++
      subscriptions.set(id, {
        id,
        amount: plan?.amount ?? checkout.amount,
        customer: { id: 1, customer_email: checkout.customer?.email ?? '' },
        plan: checkout.payment_plan,
        status: 'active',
        created_at: new Date().toISOString(),
        firstTransaction: transaction,
      })
    }
    const target = new URL(checkout.redirect_url)
    target.searchParams.set('status', 'successful')
    target.searchParams.set('tx_ref', checkout.tx_ref)
    target.searchParams.set('transaction_id', String(transaction.id))
    res.writeHead(302, { location: target.toString() })
    return res.end()
  }

  if (req.method === 'POST' && path === '/flw/test/renewal') {
    const body = await readBody(req)
    const subscription = [...subscriptions.values()]
      .filter((s) => s.customer.customer_email === body.customer_email)
      .at(-1)
    if (!subscription) return send(res, 404, { ok: false, error: 'no subscription' })
    if (subscription.status !== 'active') return send(res, 409, { ok: false, error: 'not active' })
    const transaction = charge({
      txRef: subscription.firstTransaction.tx_ref,
      amount: subscription.amount,
      status: body.status === 'failed' ? 'failed' : 'successful',
      email: subscription.customer.customer_email,
      plan: subscription.plan,
    })
    const hook = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'verif-hash': WEBHOOK_HASH },
      body: JSON.stringify({
        event: 'charge.completed',
        data: {
          id: transaction.id,
          tx_ref: transaction.tx_ref,
          status: transaction.status,
          amount: transaction.amount,
          currency: 'NGN',
        },
      }),
    }).catch(() => null)
    return send(res, 200, {
      ok: true,
      transactionId: transaction.id,
      webhookStatus: hook?.status ?? 0,
    })
  }

  // N12 in the mock too: test keys only.
  if (!req.headers.authorization?.includes('_TEST-')) {
    return send(res, 401, { status: 'error', message: 'Test keys only' })
  }

  if (req.method === 'POST' && path === '/flw/v3/payment-plans') {
    const body = await readBody(req)
    if (typeof body.amount !== 'number' || !body.name || body.interval !== 'monthly') {
      return send(res, 400, { status: 'error', message: 'amount, name and interval are required' })
    }
    const id = nextId++
    const plan = {
      id,
      name: body.name,
      amount: body.amount,
      interval: body.interval,
      duration: 0,
      status: 'active',
      currency: body.currency ?? 'NGN',
      plan_token: `rpp_mock${id}`,
      created_at: new Date().toISOString(),
    }
    plans.set(id, plan)
    return send(res, 200, { status: 'success', message: 'Payment plan created', data: plan })
  }

  if (req.method === 'POST' && path === '/flw/v3/payments') {
    const body = await readBody(req)
    if (body.payment_plan !== undefined) {
      if (!Number.isSafeInteger(body.payment_plan) || body.payment_plan <= 0) {
        return send(res, 400, { status: 'error', message: 'No such payment plan' })
      }
      // Flutterwave keeps plan objects; this mock forgets them when it restarts,
      // while the database remembers one made in an earlier run. Take it as kept.
      if (!plans.has(body.payment_plan)) {
        plans.set(body.payment_plan, {
          id: body.payment_plan,
          amount: body.amount,
          interval: 'monthly',
        })
      }
    }
    const id = nextId++
    checkouts.set(id, body)
    return send(res, 200, {
      status: 'success',
      message: 'Hosted Link',
      data: { link: `http://${req.headers.host}/flw/pay/${id}` },
    })
  }

  const verify = path.match(/^\/flw\/v3\/transactions\/(\d+)\/verify$/)
  if (req.method === 'GET' && verify) {
    const transaction = transactions.get(Number(verify[1]))
    if (!transaction)
      return send(res, 404, { status: 'error', message: 'No transaction was found for this id' })
    return send(res, 200, {
      status: 'success',
      message: 'Transaction fetched successfully',
      data: transaction,
    })
  }

  if (req.method === 'GET' && path === '/flw/v3/subscriptions') {
    const transactionId = Number(url.searchParams.get('transaction_id'))
    const found = [...subscriptions.values()].filter(
      (s) => !transactionId || s.firstTransaction.id === transactionId,
    )
    return send(res, 200, {
      status: 'success',
      message: 'Plan subscriptions fetched',
      meta: { page_info: { total: found.length, current_page: 1, total_pages: 1 } },
      data: found.map(({ firstTransaction: _first, ...s }) => s),
    })
  }

  const change = path.match(/^\/flw\/v3\/subscriptions\/(\d+)\/(cancel|activate)$/)
  if (req.method === 'PUT' && change) {
    const subscription = subscriptions.get(Number(change[1]))
    if (!subscription) return send(res, 404, { status: 'error', message: 'No subscription found' })
    subscription.status = change[2] === 'cancel' ? 'cancelled' : 'active'
    const { firstTransaction: _first, ...data } = subscription
    return send(res, 200, {
      status: 'success',
      message: change[2] === 'cancel' ? 'Subscription cancelled' : 'Subscription activated',
      data,
    })
  }

  return send(res, 404, { status: 'error', message: 'Not mocked' })
}

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true })
  if (req.url?.startsWith('/flw/')) return void flutterwave(req, res)
  return send(res, 404, { ok: false })
}).listen(PORT, '127.0.0.1')
