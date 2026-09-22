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

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
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
    throw new Error(`Flutterwave ${response.status}`)
  }
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

/** Null when Flutterwave has no such transaction, or cannot be reached. */
export async function verifyTransaction(
  transactionId: string,
): Promise<FlutterwaveTransaction | null> {
  if (!/^\d+$/.test(transactionId)) return null
  try {
    const body = await call<{ status: string; data?: FlutterwaveTransaction }>(
      `/transactions/${transactionId}/verify`,
    )
    return body.status === 'success' && body.data ? body.data : null
  } catch {
    return null
  }
}

/** SEC-7 — the `verif-hash` header must equal our secret hash, compared in constant time. */
export function webhookHashMatches(received: string | null, expected: string): boolean {
  if (!received) return false
  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
