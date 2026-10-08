import 'server-only'

import { timingSafeEqual } from 'node:crypto'
import { env, requirePaymentEnv } from '@/lib/env'
import { logger } from '@/lib/logger'

/**
 * Flutterwave v3 (PRD §8.4, FR-C9, SEC-7). Hosted checkout: we create a
 * payment link, the customer pays on Flutterwave's page, and we verify the
 * transaction with the API before believing anything a redirect or webhook
 * says. Card details never touch our servers.
 */

export type FlutterwaveTransaction = {
  id: number
  tx_ref: string
  status: string
  /** What we asked for, in naira — excluding any fee the customer paid on top. */
  amount: number
  currency: string
  payment_type?: string
}

const TIMEOUT_MS = 15_000

type Answer<T> = { status: number; body: T | null }

/** One call. A response of any status is an answer; no response throws. */
async function request<T>(path: string, init: RequestInit = {}): Promise<Answer<T>> {
  const { secretKey } = requirePaymentEnv()
  const response = await fetch(`${env.FLUTTERWAVE_API_URL}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${secretKey}`,
      'content-type': 'application/json',
      ...init.headers,
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const body = (await response.json().catch(() => null)) as T | null
  if (!response.ok || !body) {
    // Status only — Flutterwave error bodies can echo customer details.
    logger.warn({ path: path.split('/')[1], status: response.status }, 'flutterwave call failed')
  }
  return { status: response.status, body }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { status, body } = await request<T>(path, init)
  if (status < 200 || status >= 300 || !body) throw new Error(`Flutterwave ${status}`)
  return body
}

export async function createPaymentLink(input: {
  txRef: string
  amountKobo: number
  redirectUrl: string
  customer: { email: string; name: string; phone?: string }
  orderNumber: string
}): Promise<string> {
  const body = await call<{ status: string; data?: { link?: string } }>('/payments', {
    method: 'POST',
    body: JSON.stringify({
      tx_ref: input.txRef,
      amount: input.amountKobo / 100,
      currency: 'NGN',
      redirect_url: input.redirectUrl,
      payment_options: 'card,banktransfer,ussd',
      // The hosted page closes after a day, when an unpaid order is closed
      // (expire_unpaid_orders): a link kept for weeks cannot pay an old price
      // (security audit, 8 Oct 2026). Flutterwave's maximum, in minutes.
      session_duration: 1440,
      customer: {
        email: input.customer.email,
        name: input.customer.name,
        phonenumber: input.customer.phone,
      },
      customizations: {
        title: env.NEXT_PUBLIC_APP_NAME,
        description: `Order ${input.orderNumber}`,
      },
      meta: { order_number: input.orderNumber },
    }),
  })
  const link = body.data?.link
  if (body.status !== 'success' || !link) throw new Error('Flutterwave returned no payment link')
  return link
}

/**
 * What Flutterwave says about a transaction, told apart from not hearing:
 *   found       — it answered with the transaction;
 *   missing     — it answered that there is no such transaction (for this key);
 *   unreachable — no answer, a 5xx or 429, a refused key, or an answer we
 *                 cannot read. Nothing is known yet; ask again later.
 * A payment must never be dropped because Flutterwave was slow once.
 */
export type VerifiedTransaction =
  | { kind: 'found'; transaction: FlutterwaveTransaction }
  | { kind: 'missing' }
  | { kind: 'unreachable' }

function isTransaction(value: unknown): value is FlutterwaveTransaction {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return (
    typeof row.id === 'number' &&
    typeof row.tx_ref === 'string' &&
    typeof row.status === 'string' &&
    typeof row.amount === 'number' &&
    Number.isFinite(row.amount) &&
    typeof row.currency === 'string'
  )
}

export async function verifyTransaction(transactionId: string): Promise<VerifiedTransaction> {
  if (!/^\d{1,20}$/.test(transactionId)) return { kind: 'missing' }
  let answer: Answer<{ status?: string; data?: unknown }>
  try {
    answer = await request(`/transactions/${transactionId}/verify`)
  } catch {
    return { kind: 'unreachable' }
  }
  const { status, body } = answer
  // Our own key refused, or Flutterwave struggling: nothing is known yet.
  if (status === 401 || status === 403 || status === 429 || status >= 500) {
    return { kind: 'unreachable' }
  }
  if (status >= 400) return { kind: 'missing' }
  if (body?.status === 'success' && isTransaction(body.data)) {
    // Flutterwave answered for this id: make sure it is the one we asked about.
    return String(body.data.id) === transactionId
      ? { kind: 'found', transaction: body.data }
      : { kind: 'unreachable' }
  }
  if (body?.status === 'error') return { kind: 'missing' }
  return { kind: 'unreachable' }
}

/** SEC-7 — the `verif-hash` header must equal our secret hash, compared in constant time. */
export function webhookHashMatches(received: string | null, expected: string): boolean {
  if (!received) return false
  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
