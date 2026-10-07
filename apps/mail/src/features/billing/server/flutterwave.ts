import 'server-only'

import { timingSafeEqual } from 'node:crypto'
import { logger } from '@/lib/logger'
import {
  type ChargeFacts,
  hasMorePages,
  isStopped,
  oldestFirst,
  type ProviderSubscription,
  readCharge,
  readSubscriptions,
  TRANSACTION_ID,
} from '../lib/flutterwave'
import type { BillingSettings } from './env'

/**
 * Flutterwave v3 for Mail's billing (MAIL-SPEC §8): payment plan objects, the
 * hosted checkout, re-reading a charge (SEC-7) and stopping or restarting a
 * subscription. Card details never reach us. Logs carry paths and statuses
 * only — Flutterwave's error bodies can echo a customer's details (N13).
 * Sources and what is unverified: ../lib/flutterwave.ts.
 */

const TIMEOUT_MS = 15_000

type Answer = { status: number; body: Record<string, unknown> | null }

async function request(
  settings: BillingSettings,
  path: string,
  init: RequestInit = {},
): Promise<Answer> {
  const response = await fetch(`${settings.apiUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${settings.secretKey}`,
      'content-type': 'application/json',
      ...init.headers,
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok || !body) {
    logger.warn(
      { path: path.split('?')[0]?.replace(/\d+/g, ':id'), status: response.status },
      'flutterwave call failed',
    )
  }
  return { status: response.status, body: body && typeof body === 'object' ? body : null }
}

/** One call that must succeed; null for any failure (already logged). */
async function call(settings: BillingSettings, path: string, init: RequestInit = {}) {
  try {
    const { status, body } = await request(settings, path, init)
    return status >= 200 && status < 300 && body?.status === 'success' ? body : null
  } catch {
    logger.warn({ path: path.split('?')[0]?.replace(/\d+/g, ':id') }, 'flutterwave did not answer')
    return null
  }
}

/** POST /v3/payment-plans: a monthly plan object charging `amountKobo`. */
export async function createPaymentPlan(
  settings: BillingSettings,
  input: { name: string; amountKobo: number },
): Promise<number | null> {
  const body = await call(settings, '/payment-plans', {
    method: 'POST',
    body: JSON.stringify({
      name: input.name,
      amount: input.amountKobo / 100,
      interval: 'monthly',
      currency: 'NGN',
    }),
  })
  const data = body?.data as { id?: unknown } | undefined
  return typeof data?.id === 'number' && Number.isSafeInteger(data.id) && data.id > 0
    ? data.id
    : null
}

/**
 * POST /v3/payments: Flutterwave's hosted checkout for a checkout's first
 * charge, subscribing the card to the plan object (`payment_plan`). The first
 * charge is `amountKobo` (an upgrade's is prorated); later ones are the
 * plan's amount. A payment plan fixes the method to card.
 */
export async function createPaymentLink(
  settings: BillingSettings,
  input: {
    txRef: string
    amountKobo: number
    flutterwavePlanId: number
    redirectUrl: string
    customer: { email: string; name: string }
    description: string
  },
): Promise<string | null> {
  const body = await call(settings, '/payments', {
    method: 'POST',
    body: JSON.stringify({
      tx_ref: input.txRef,
      amount: input.amountKobo / 100,
      currency: 'NGN',
      payment_plan: input.flutterwavePlanId,
      redirect_url: input.redirectUrl,
      customer: { email: input.customer.email, name: input.customer.name },
      customizations: { title: 'MyDomainsHub Mail', description: input.description },
    }),
  })
  const link = (body?.data as { link?: unknown } | undefined)?.link
  return typeof link === 'string' && /^https?:\/\//.test(link) ? link : null
}

/**
 * GET /v3/transactions/:id/verify, told apart from not hearing:
 *   found       — Flutterwave answered with this transaction;
 *   missing     — it answered that there is no such transaction for our key;
 *   unreachable — no answer, a 5xx or 429, a refused key, or an answer we
 *                 cannot read. Nothing is known yet: ask again later.
 */
export type Verified =
  | { kind: 'found'; charge: ChargeFacts }
  | { kind: 'missing' }
  | { kind: 'unreachable' }

export async function verifyTransaction(
  settings: BillingSettings,
  transactionId: string,
): Promise<Verified> {
  if (!TRANSACTION_ID.test(transactionId)) return { kind: 'missing' }
  let answer: Answer
  try {
    answer = await request(settings, `/transactions/${transactionId}/verify`)
  } catch {
    return { kind: 'unreachable' }
  }
  const { status, body } = answer
  if (status === 401 || status === 403 || status === 429 || status >= 500)
    return { kind: 'unreachable' }
  if (status >= 400) return { kind: 'missing' }
  if (body?.status === 'success') {
    const charge = readCharge(body.data)
    // Flutterwave answered for this id: make sure it is the one we asked about.
    return charge && charge.id === transactionId
      ? { kind: 'found', charge }
      : { kind: 'unreachable' }
  }
  return body?.status === 'error' ? { kind: 'missing' } : { kind: 'unreachable' }
}

/**
 * GET /v3/subscriptions?transaction_id=: every subscription a first charge
 * started, earliest-made first. Usually one; a live test-mode run (7 Oct
 * 2026) showed one charge starting two, so callers act on them all.
 *   found       — Flutterwave listed at least one, on a single page;
 *   missing     — it listed none for this charge;
 *   unreachable — no answer, or one that leaves some out (more pages).
 */
export type FoundSubscriptions =
  | { kind: 'found'; subscriptions: ProviderSubscription[] }
  | { kind: 'missing' }
  | { kind: 'unreachable' }

export async function findSubscriptions(
  settings: BillingSettings,
  firstTransactionId: string,
): Promise<FoundSubscriptions> {
  if (!TRANSACTION_ID.test(firstTransactionId)) return { kind: 'missing' }
  const body = await call(settings, `/subscriptions?transaction_id=${firstTransactionId}`)
  if (!body || hasMorePages(body.meta)) return { kind: 'unreachable' }
  const subscriptions = oldestFirst(readSubscriptions(body.data))
  return subscriptions.length > 0 ? { kind: 'found', subscriptions } : { kind: 'missing' }
}

/** PUT /v3/subscriptions/:id/cancel or /activate; true once Flutterwave says it is done. */
export async function setSubscription(
  settings: BillingSettings,
  id: number,
  to: 'cancel' | 'activate',
): Promise<boolean> {
  const body = await call(settings, `/subscriptions/${id}/${to}`, { method: 'PUT' })
  const status = (body?.data as { status?: unknown } | undefined)?.status
  if (typeof status !== 'string') return false
  return to === 'cancel' ? isStopped(status) : /^active$/i.test(status)
}

/** SEC-7: the `verif-hash` header must equal the account's secret hash, compared in constant time. */
export function webhookHashMatches(received: string | null, expected: string): boolean {
  if (!received) return false
  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
