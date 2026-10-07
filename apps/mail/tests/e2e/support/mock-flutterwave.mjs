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
 * And controls for tests, standing in for Flutterwave's own behaviour:
 *
 *   POST /flw/test/renewal { customer_email, status, all? }
 *     charges the customer's latest subscription again on its first charge's
 *     reference — successful or failed — and sends `charge.completed` to the
 *     app's webhook with the account's hash, as Paidly forwards it. With
 *     `all`, every active subscription of the customer renews, earliest-made
 *     first, each webhook answered before the next charge.
 *   POST /flw/test/duplicate-next-payment { customer_email }
 *     the customer's next "Pay (test)" starts two subscriptions on its one
 *     charge, the second made 174 s after the first — as a live test-mode
 *     run did (7 Oct 2026: charge 10534506, subscriptions 53194 and 53195).
 *   POST /flw/test/duplicate-subscription { customer_email }
 *     a second active subscription on the customer's latest first charge,
 *     made now: one that turns up after the payment was settled.
 *   GET  /flw/test/subscriptions?customer_email=
 *     the customer's subscriptions, earliest-made first: id, status, first charge.
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
/** Customers whose next payment starts two subscriptions. */
const duplicateNextPayment = new Set()
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

/** A customer's subscriptions, earliest-made first. */
function customerSubscriptions(email) {
  return [...subscriptions.values()]
    .filter((s) => s.customer.customer_email === email)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id)
}

/** One renewal charge, and its webhook as Paidly forwards it; the app's answer awaited. */
async function renew(subscription, status) {
  const transaction = charge({
    txRef: subscription.firstTransaction.tx_ref,
    amount: subscription.amount,
    status,
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
  return { transactionId: transaction.id, webhookStatus: hook?.status ?? 0 }
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
      const email = checkout.customer?.email ?? ''
      const made = Date.now()
      const twice = duplicateNextPayment.delete(email)
      // Dated in the past, so anything made later sorts after both.
      for (const delay of twice ? [-174_000, 0] : [0]) {
        const id = nextId++
        subscriptions.set(id, {
          id,
          amount: plan?.amount ?? checkout.amount,
          customer: { id: 1, customer_email: email },
          plan: checkout.payment_plan,
          status: 'active',
          created_at: new Date(made + delay).toISOString(),
          firstTransaction: transaction,
        })
      }
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
    const mine = customerSubscriptions(body.customer_email)
    const due = body.all ? mine.filter((s) => s.status === 'active') : mine.slice(-1)
    if (due.length === 0) return send(res, 404, { ok: false, error: 'no subscription' })
    if (due.some((s) => s.status !== 'active')) {
      return send(res, 409, { ok: false, error: 'not active' })
    }
    const renewed = []
    for (const subscription of due) {
      renewed.push(await renew(subscription, body.status === 'failed' ? 'failed' : 'successful'))
    }
    return send(res, 200, {
      ok: true,
      transactionId: renewed[0]?.transactionId,
      webhookStatus: renewed[0]?.webhookStatus ?? 0,
      transactionIds: renewed.map((r) => r.transactionId),
      webhookStatuses: renewed.map((r) => r.webhookStatus),
    })
  }

  if (req.method === 'POST' && path === '/flw/test/duplicate-next-payment') {
    const body = await readBody(req)
    if (!body.customer_email) return send(res, 400, { ok: false, error: 'customer_email' })
    duplicateNextPayment.add(body.customer_email)
    return send(res, 200, { ok: true })
  }

  if (req.method === 'POST' && path === '/flw/test/duplicate-subscription') {
    const body = await readBody(req)
    const latest = customerSubscriptions(body.customer_email).at(-1)
    if (!latest) return send(res, 404, { ok: false, error: 'no subscription' })
    const id = nextId++
    subscriptions.set(id, {
      ...latest,
      id,
      status: 'active',
      created_at: new Date().toISOString(),
    })
    return send(res, 200, { ok: true, id })
  }

  if (req.method === 'GET' && path === '/flw/test/subscriptions') {
    const mine = customerSubscriptions(url.searchParams.get('customer_email'))
    return send(res, 200, {
      ok: true,
      subscriptions: mine.map((s) => ({
        id: s.id,
        status: s.status,
        firstTransactionId: s.firstTransaction.id,
      })),
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
