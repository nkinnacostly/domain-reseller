import { assessTransaction, transactionRecord } from '@dr/shared'
import type { Flutterwave, FlutterwaveCharge } from './flutterwave'
import type { ChargeToRecord, DueOrder, PaymentStore } from './store'

/**
 * Finds payments nobody told us about (PRD §13.4, SEC-7).
 *
 * A charge normally reaches us twice: the customer's redirect and
 * Flutterwave's webhook. Both can fail — a closed tab, and a webhook that
 * could not be settled three times running. Then the customer has paid and
 * the order says unpaid, or has paid twice and the second charge is never
 * refunded. So every few minutes this lists, from Flutterwave, every charge
 * made against the reference of each order from the last three days —
 * unpaid, or paid — and records any it has not seen, through the same
 * functions and rules as the web app: the first full charge pays the order,
 * anything more is refunded.
 */

type Log = {
  info(fields: object, message: string): void
  warn(fields: object, message: string): void
  error(fields: object, message: string): void
}

export type PaymentSweeperOptions = {
  store: PaymentStore
  flutterwave: Flutterwave
  /** Test orders are asked about with the test key, live ones with the live key. */
  testMode: boolean
  everyMs: number
  /** Orders asked about per run: each is one Flutterwave call. */
  batch?: number
  log: Log
}

export function createPaymentSweeper(options: PaymentSweeperOptions) {
  const { store, flutterwave, testMode, everyMs, batch = 20, log } = options

  function toRecord(order: DueOrder, charge: FlutterwaveCharge): ChargeToRecord {
    const method = charge.raw.payment_type
    return {
      orderId: order.id,
      providerReference: charge.id,
      amountKobo: charge.amountKobo,
      currency: charge.currency,
      method: typeof method === 'string' ? method.slice(0, 40) : '',
      // Never the whole answer: it carries the customer and a reusable card token.
      raw: transactionRecord(charge.raw),
    }
  }

  async function incident(
    kind: 'tx_ref_mismatch' | 'currency_mismatch' | 'unrecorded_payment',
    order: DueOrder,
    charge: FlutterwaveCharge,
  ) {
    try {
      await store.recordIncident(kind, order.id, charge.id, {
        status: charge.status,
        currency: charge.currency,
        amount_kobo: charge.amountKobo,
      })
    } catch (error) {
      log.error({ err: error, order: order.orderNumber, kind }, 'payment incident not recorded')
    }
  }

  const DAY_MS = 86_400_000

  /** Records one charge we had not seen. What came of it, for the log and the tests. */
  async function settle(order: DueOrder, charge: FlutterwaveCharge): Promise<string> {
    const verdict = assessTransaction(
      {
        tx_ref: charge.txRef,
        status: charge.status,
        amount: charge.amountKobo / 100,
        currency: charge.currency,
      },
      { txRef: order.txRef, totalKobo: order.totalKobo },
    )
    if (verdict === 'pending' || verdict === 'failed') return verdict
    if (verdict === 'wrong_order' || verdict === 'wrong_currency') {
      await incident(
        verdict === 'wrong_order' ? 'tx_ref_mismatch' : 'currency_mismatch',
        order,
        charge,
      )
      return verdict
    }

    try {
      // A full charge on an order already paid is recorded as a second
      // charge, and refunded, by record_order_payment itself.
      if (verdict === 'underpaid') await store.recordUnderpayment(toRecord(order, charge))
      else await store.recordPayment(toRecord(order, charge))
    } catch (error) {
      log.error({ err: error, order: order.orderNumber }, 'found payment could not be recorded')
      await incident('unrecorded_payment', order, charge)
      return 'unrecorded'
    }
    // Worth a look: the redirect and every webhook delivery missed this one.
    log.warn(
      { order: order.orderNumber, verdict, sandbox: testMode },
      'sweeper recorded a payment nothing else had',
    )
    return verdict
  }

  /** Asks about one order. What it found, charge by charge. */
  async function check(order: DueOrder): Promise<string[]> {
    const placed = Date.parse(order.createdAt)
    const found = await flutterwave.listCharges(
      order.txRef,
      new Date((Number.isFinite(placed) ? placed : Date.now()) - DAY_MS),
      new Date(Date.now() + DAY_MS),
    )
    if (found.kind !== 'ok') {
      log.warn({ order: order.orderNumber, code: found.code }, 'could not ask about an order')
      return ['unknown']
    }
    if (!found.data.complete) {
      // Recording is safe on any page; the rest are read on the next pass.
      log.warn({ order: order.orderNumber }, 'more charges on one reference than one page')
    }
    const unseen = found.data.charges
      .filter((charge) => !order.knownReferences.includes(charge.id))
      // Oldest first, so the first full charge is the one that pays the order.
      .sort((a, b) => Number(a.id) - Number(b.id))
    if (unseen.length === 0) return ['nothing_new']

    const outcomes: string[] = []
    for (const charge of unseen) outcomes.push(await settle(order, charge))
    return outcomes
  }

  /** One pass over the orders that are due. */
  async function sweep(): Promise<Record<string, number>> {
    const due = await store.ordersToCheck(testMode, batch)
    const tally: Record<string, number> = {}
    for (const order of due) {
      let outcomes: string[]
      try {
        outcomes = await check(order)
      } catch (error) {
        log.error({ err: error, order: order.orderNumber }, 'payment check crashed')
        outcomes = ['error']
      }
      for (const outcome of outcomes) tally[outcome] = (tally[outcome] ?? 0) + 1
    }
    return tally
  }

  let timer: ReturnType<typeof setInterval> | null = null
  let running: Promise<unknown> | null = null

  function run() {
    if (running) return
    running = sweep()
      .catch((error) => log.error({ err: error }, 'payment sweep failed'))
      .finally(() => {
        running = null
      })
  }

  return {
    sweep,
    start() {
      if (timer) return
      run()
      timer = setInterval(run, everyMs)
    },
    async stop() {
      if (timer) clearInterval(timer)
      timer = null
      await running
    },
  }
}
