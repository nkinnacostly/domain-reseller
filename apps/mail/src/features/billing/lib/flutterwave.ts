import { nairaToKobo, transactionRecord } from '@dr/shared/payments'

/**
 * What we read from Flutterwave's v3 answers (MAIL-SPEC §8; CLAUDE.md, the
 * money rows of §15). Pure: the HTTP calls are in ../server/flutterwave.ts.
 *
 * Sources, read 6 Oct 2026:
 *   payment plans  https://developer.flutterwave.com/v3.0/docs/payment-plans-1
 *     POST /v3/payment-plans {amount, name, interval, currency} → data.id;
 *     `payment_plan` on a payment subscribes the customer, "the custom amount
 *     for the first payment, and the standard amount on the plan for
 *     subsequent payments"; a failed renewal is tried 3 more times, 30
 *     minutes apart, then the subscription is cancelled.
 *   subscriptions  https://developer.flutterwave.com/v3.0/reference/get-all-subscriptions
 *     GET /v3/subscriptions?transaction_id=… → data[] {id, plan, status, created_at},
 *     meta.page_info {total, current_page, total_pages};
 *     PUT /v3/subscriptions/:id/cancel and /activate (Flutterwave's Node-v3
 *     SDK, documentation/subscription.md, services/subscriptions/).
 *   webhooks       https://developer.flutterwave.com/v3.0/docs/webhooks
 *     `verif-hash` is the account's secret hash; only a 200 is delivered.
 *
 * Seen in a live test-mode run on an hourly plan (7 Oct 2026): Flutterwave's
 * renewal charges carry the first charge's tx_ref, so a later charge on a paid
 * checkout's reference is its renewal. The same run showed one checkout charge
 * (10534506) starting two subscriptions for one customer and plan (53194,
 * then 53195 three minutes later), both renewing; `?transaction_id=` lists
 * both. So a first charge may have several subscriptions: all are stopped
 * when a plan must stop renewing, and otherwise only the earliest-made is
 * kept (../server/provider.ts, ../server/duplicates.ts; migration 56).
 */

/** Every Mail checkout's reference starts with this; Paidly forwards these here (§8). */
export const MAIL_TX_REF_PREFIX = 'MDM-'

/** `MDM-<checkout uuid>`, exactly as migration 50 issues it. */
export const MAIL_TX_REF = /^MDM-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const TRANSACTION_ID = /^\d{1,20}$/

/** The name a plan object carries — Flutterwave puts it on its reminder emails. */
export const planObjectName = (planName: string) => `MyDomainsHub Mail ${planName}, monthly`

export type ChargeFacts = {
  id: string
  txRef: string
  status: string
  amountKobo: number
  currency: string
  method: string
  /** The card's last four digits and scheme, if the charge was by card; nothing else of it. */
  cardLast4: string | null
  cardBrand: string | null
  /** payments.raw: the shop's allowlist (no customer, no card token). */
  record: ReturnType<typeof transactionRecord>
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** A verify answer's `data`, read; null when it is not a transaction. */
export function readCharge(data: unknown): ChargeFacts | null {
  if (!isObject(data)) return null
  const { id, tx_ref, status, amount, currency } = data
  if (
    typeof id !== 'number' ||
    !Number.isSafeInteger(id) ||
    typeof tx_ref !== 'string' ||
    typeof status !== 'string' ||
    typeof amount !== 'number' ||
    !Number.isFinite(amount) ||
    typeof currency !== 'string'
  ) {
    return null
  }
  const card = isObject(data.card) ? data.card : {}
  const last4 = typeof card.last_4digits === 'string' ? card.last_4digits : ''
  const brand = typeof card.type === 'string' ? card.type : ''
  return {
    id: String(id),
    txRef: tx_ref,
    status,
    amountKobo: nairaToKobo(amount),
    currency,
    method: typeof data.payment_type === 'string' ? data.payment_type.slice(0, 40) : '',
    cardLast4: /^\d{4}$/.test(last4) ? last4 : null,
    cardBrand: /^[A-Za-z][A-Za-z ]{1,19}$/.test(brand) ? brand.toUpperCase() : null,
    record: transactionRecord(data),
  }
}

export type ProviderSubscription = {
  id: number
  status: string
  plan: number | null
  /** When Flutterwave made it, as it says (ISO 8601); null when it does not say. */
  createdAt: string | null
}

/** GET /v3/subscriptions' `data`, read; odd rows are dropped. */
export function readSubscriptions(data: unknown): ProviderSubscription[] {
  if (!Array.isArray(data)) return []
  return data.flatMap((row) => {
    if (!isObject(row) || typeof row.id !== 'number' || typeof row.status !== 'string') return []
    const createdAt =
      typeof row.created_at === 'string' && Number.isFinite(Date.parse(row.created_at))
        ? row.created_at
        : null
    return [
      {
        id: row.id,
        status: row.status,
        plan: typeof row.plan === 'number' ? row.plan : null,
        createdAt,
      },
    ]
  })
}

/**
 * Whether a listing says it has more pages than the one read. Every
 * subscription of a first charge must be seen to stop them all, so an answer
 * that leaves some out is no answer.
 */
export function hasMorePages(meta: unknown): boolean {
  const info = isObject(meta) && isObject(meta.page_info) ? meta.page_info : null
  return typeof info?.total_pages === 'number' && info.total_pages > 1
}

/**
 * Earliest-made first: the order in which a first charge's subscriptions are
 * kept (the earliest) and stopped (the rest, newest first). By Flutterwave's
 * `created_at`, then its id; by id alone when any date is missing, so the
 * order is the same however the list arrives.
 */
export function oldestFirst(
  subscriptions: readonly ProviderSubscription[],
): ProviderSubscription[] {
  const dated = subscriptions.every((subscription) => subscription.createdAt !== null)
  return [...subscriptions].sort((a, b) => {
    const byDate = dated ? Date.parse(a.createdAt ?? '') - Date.parse(b.createdAt ?? '') : 0
    return byDate !== 0 ? byDate : a.id - b.id
  })
}

/** A Flutterwave subscription that will charge no more. */
export const isStopped = (status: string) => /^(cancelled|canceled|deactivated)$/i.test(status)

/** A webhook body, as a hint only: nothing in it is believed until Flutterwave confirms it. */
export function readWebhook(body: unknown): {
  event: string
  transactionId: string | null
  txRef: string | null
} {
  if (!isObject(body)) return { event: '', transactionId: null, txRef: null }
  const data = isObject(body.data) ? body.data : {}
  const id = String(data.id ?? '')
  const txRef = typeof data.tx_ref === 'string' ? data.tx_ref : ''
  return {
    event: typeof body.event === 'string' ? body.event : '',
    transactionId: TRANSACTION_ID.test(id) ? id : null,
    txRef: txRef.length > 0 && txRef.length <= 100 ? txRef : null,
  }
}
