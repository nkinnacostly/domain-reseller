import { type JsonResponse, NoAnswer, requestJson } from '../lib/http'

/**
 * The Flutterwave v3 calls the refund worker needs, and nothing else.
 *
 * Plain REST, not Flutterwave's Node SDK: the SDK's refund schema rejects
 * documented fields, it has no way to read refunds back, and recent versions
 * report request paths — transaction ids included — to a telemetry service.
 *
 * Every call answers in three ways, as the supplier's do (I2):
 *   ok       — Flutterwave answered and it worked;
 *   rejected — Flutterwave answered and said no;
 *   unknown  — no answer, a 5xx or a 429: nobody knows yet. Flutterwave's
 *              own docs say a timed-out call "does not always mean failure".
 * Error text is kept to Flutterwave's short message: its error bodies can
 * echo customer details, which never reach a log or the database (N13).
 */

export type FlutterwaveRefund = {
  id: string
  /** The charge it refunds (`tx_id`), when Flutterwave says. */
  transactionId: string | null
  amountKobo: number
  /** Flutterwave's refund status, e.g. `completed` (initiated) or `completed-mpgs` (done). */
  status: string
  /** From `meta.disburse_status`, when Flutterwave says. */
  disburseStatus: string | null
  createdAt: string | null
}

/** A charge, as Flutterwave's verify endpoints report it. */
export type FlutterwaveCharge = {
  id: string
  txRef: string
  flwRef: string | null
  status: string
  currency: string
  /** What we asked for, in kobo — excluding any fee the customer paid on top. */
  amountKobo: number
  /** The whole answer, for the payment sweeper to keep a sanitised copy of. */
  raw: Record<string, unknown>
}

export type FlutterwaveResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'rejected'; code: string; message: string }
  | { kind: 'unknown'; code: string; message: string }

export interface Flutterwave {
  /** `amountKobo` null refunds the whole charge. */
  createRefund(
    transactionId: string,
    amountKobo: number | null,
  ): Promise<FlutterwaveResult<FlutterwaveRefund>>
  /** Every refund made against one charge. `complete` false: there were more than one page. */
  listRefunds(
    transactionId: string,
    from: Date,
    to: Date,
  ): Promise<FlutterwaveResult<{ refunds: FlutterwaveRefund[]; complete: boolean }>>
  getRefund(refundId: string): Promise<FlutterwaveResult<FlutterwaveRefund>>
  /** How many disputes have been filed against the charge. */
  chargebackCount(flwRef: string): Promise<FlutterwaveResult<number>>
  availableBalanceKobo(): Promise<FlutterwaveResult<number>>
  /** The charge with this id. `rejected` when Flutterwave has none. */
  verifyTransaction(transactionId: string): Promise<FlutterwaveResult<FlutterwaveCharge>>
  /**
   * Every charge made against one of our references between two dates — a
   * customer can pay one payment link twice. `complete` false: more than one page.
   */
  listCharges(
    txRef: string,
    from: Date,
    to: Date,
  ): Promise<FlutterwaveResult<{ charges: FlutterwaveCharge[]; complete: boolean }>>
}

/** Charge states that took no money: nothing was paid, and nothing can be refunded. */
const UNSETTLED = new Set(['failed', 'pending', 'cancelled', 'abandoned', 'error'])

/**
 * Whether a charge took the customer's money. A refused list rather than an
 * accepted one: a charge that has since been part-refunded may report a
 * status other than `successful`, and must still count as paid.
 */
export function chargeTookMoney(status: string): boolean {
  return !UNSETTLED.has(status.toLowerCase())
}

/** Flutterwave refuses refunds under ₦100. */
export const MIN_REFUND_KOBO = 10_000

/**
 * Where a refund stands. A bare `completed` means "initiated, pending
 * disbursement" — Flutterwave's own sample pairs it with a failed
 * disbursement — so only a `completed-*` status or a successful disbursement
 * counts as done. Anything unrecognised is still pending.
 */
export function refundState(refund: FlutterwaveRefund): 'done' | 'failed' | 'pending' {
  const status = refund.status.toLowerCase()
  const disburse = refund.disburseStatus?.toLowerCase() ?? null
  if (disburse === 'failed' || status === 'failed') return 'failed'
  if (status.startsWith('completed-')) return 'done'
  if (disburse === 'completed' || disburse === 'successful' || disburse === 'success') return 'done'
  return 'pending'
}

type Request = (url: string, init: Parameters<typeof requestJson>[1]) => Promise<JsonResponse>

const toKobo = (naira: unknown): number => Math.round(Number(naira) * 100)

function metaOf(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** Reads a refund from either the create answer or the refunds endpoints. */
export function parseRefund(raw: unknown): FlutterwaveRefund | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const id = row.id ?? row.refund_id
  const amount = row.amount_refunded ?? row.AmountRefunded ?? row.amount
  if ((typeof id !== 'number' && typeof id !== 'string') || amount === undefined) return null
  if (!Number.isFinite(Number(amount))) return null
  const meta = metaOf(row.meta)
  const disburse = meta.disburse_status
  const charge = row.tx_id ?? row.transaction_id
  return {
    id: String(id),
    transactionId: typeof charge === 'number' || typeof charge === 'string' ? String(charge) : null,
    amountKobo: toKobo(amount),
    status: typeof row.status === 'string' ? row.status : 'unknown',
    disburseStatus: typeof disburse === 'string' ? disburse : null,
    createdAt:
      typeof row.created_at === 'string'
        ? row.created_at
        : typeof row.createdAt === 'string'
          ? row.createdAt
          : null,
  }
}

/** Reads a charge from a verify answer. Null when it is not one. */
export function parseCharge(raw: unknown): FlutterwaveCharge | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const { id, tx_ref: txRef, flw_ref: flwRef, status, currency, amount } = row
  if (typeof id !== 'number' && typeof id !== 'string') return null
  if (typeof txRef !== 'string' || typeof status !== 'string' || typeof currency !== 'string') {
    return null
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null
  return {
    id: String(id),
    txRef,
    flwRef: typeof flwRef === 'string' ? flwRef : null,
    status,
    currency,
    amountKobo: toKobo(amount),
    raw: row,
  }
}

function shortMessage(body: unknown): string {
  const message =
    body && typeof body === 'object' ? (body as { message?: unknown }).message : undefined
  return typeof message === 'string' ? message.slice(0, 160) : 'No message'
}

/**
 * Classifies a response that arrived. Only `status: "error"` in a 2xx is a
 * refusal: the single-refund answer can come unwrapped, and then `status` is
 * the refund's own ("completed"), not the envelope's.
 */
function classify<T>(
  response: JsonResponse,
  read: (body: Record<string, unknown>) => T | null,
): FlutterwaveResult<T> {
  const { status, body } = response
  if (status === 429 || status >= 500 || status === 0) {
    return { kind: 'unknown', code: `FLW_HTTP_${status}`, message: shortMessage(body) }
  }
  if (status >= 400) {
    return { kind: 'rejected', code: `FLW_HTTP_${status}`, message: shortMessage(body) }
  }
  const envelope = body && typeof body === 'object' ? (body as Record<string, unknown>) : null
  if (!envelope) return { kind: 'unknown', code: 'FLW_BAD_BODY', message: 'Unreadable answer' }
  if (envelope.status === 'error') {
    return { kind: 'rejected', code: 'FLW_NOT_SUCCESS', message: shortMessage(body) }
  }
  const data = read(envelope)
  return data === null
    ? { kind: 'unknown', code: 'FLW_BAD_BODY', message: 'Unexpected answer shape' }
    : { kind: 'ok', data }
}

const day = (date: Date) => date.toISOString().slice(0, 10)

export function createFlutterwave(options: {
  secretKey: string
  baseUrl?: string
  timeoutMs?: number
  request?: Request
}): Flutterwave {
  const {
    secretKey,
    baseUrl = 'https://api.flutterwave.com/v3',
    // Flutterwave gives up at about 28 seconds and answers 503.
    timeoutMs = 35_000,
    request = requestJson,
  } = options
  const headers = { Authorization: `Bearer ${secretKey}` }

  async function call<T>(
    path: string,
    init: { method?: 'GET' | 'POST'; body?: unknown },
    read: (body: Record<string, unknown>) => T | null,
  ): Promise<FlutterwaveResult<T>> {
    try {
      const response = await request(`${baseUrl}${path}`, { ...init, headers, timeoutMs })
      return classify(response, read)
    } catch (error) {
      if (error instanceof NoAnswer) {
        return { kind: 'unknown', code: 'FLW_NO_ANSWER', message: error.message.slice(0, 160) }
      }
      return { kind: 'unknown', code: 'FLW_ERROR', message: 'Request could not be made' }
    }
  }

  return {
    createRefund(transactionId, amountKobo) {
      return call(
        `/transactions/${encodeURIComponent(transactionId)}/refund`,
        {
          method: 'POST',
          // Omitted, Flutterwave refunds the whole charge to the kobo.
          body: amountKobo === null ? {} : { amount: amountKobo / 100 },
        },
        (body) => parseRefund(body.data),
      )
    },

    listRefunds(transactionId, from, to) {
      const query = new URLSearchParams({ id: transactionId, from: day(from), to: day(to) })
      return call(`/refunds?${query}`, {}, (body) => {
        if (!Array.isArray(body.data)) return null
        const refunds = body.data.map(parseRefund)
        if (refunds.some((refund) => refund === null)) return null
        const pageInfo = metaOf(metaOf(body.meta).page_info)
        const totalPages = Number(pageInfo.total_pages ?? 1)
        return {
          // The account is shared with other apps. Should the filter be
          // ignored, their refunds must not count as ours. One that does not
          // say which charge it refunds is kept: an unknown refund stops a
          // send, it never lets one through.
          refunds: (refunds as FlutterwaveRefund[]).filter(
            (refund) => refund.transactionId === null || refund.transactionId === transactionId,
          ),
          complete: !Number.isFinite(totalPages) || totalPages <= 1,
        }
      })
    },

    getRefund(refundId) {
      // The single-refund answer is sometimes not wrapped in `data`.
      return call(`/refunds/${encodeURIComponent(refundId)}`, {}, (body) =>
        parseRefund(body.data ?? body),
      )
    },

    chargebackCount(flwRef) {
      const query = new URLSearchParams({ flw_ref: flwRef })
      return call(`/chargebacks?${query}`, {}, (body) =>
        Array.isArray(body.data) ? body.data.length : null,
      )
    },

    availableBalanceKobo() {
      return call('/balances/NGN', {}, (body) => {
        const data = body.data as { available_balance?: unknown } | undefined
        const available = Number(data?.available_balance)
        return Number.isFinite(available) ? toKobo(available) : null
      })
    },

    async verifyTransaction(transactionId) {
      if (!/^\d{1,20}$/.test(transactionId)) {
        return { kind: 'rejected', code: 'FLW_BAD_ID', message: 'Not a transaction id' }
      }
      const result = await call(`/transactions/${transactionId}/verify`, {}, (body) =>
        parseCharge(body.data),
      )
      // An answer about another charge is no answer.
      if (result.kind === 'ok' && result.data.id !== transactionId) {
        return { kind: 'unknown', code: 'FLW_WRONG_CHARGE', message: 'Answered for another id' }
      }
      return result
    },

    listCharges(txRef, from, to) {
      const query = new URLSearchParams({ tx_ref: txRef, from: day(from), to: day(to) })
      return call(`/transactions?${query}`, {}, (body) => {
        if (!Array.isArray(body.data)) return null
        const charges = body.data.map(parseCharge)
        if (charges.some((charge) => charge === null)) return null
        const pageInfo = metaOf(metaOf(body.meta).page_info)
        const totalPages = Number(pageInfo.total_pages ?? 1)
        return {
          // Should the filter be ignored, another reference's charges are not ours.
          charges: (charges as FlutterwaveCharge[]).filter((charge) => charge.txRef === txRef),
          complete: !Number.isFinite(totalPages) || totalPages <= 1,
        }
      })
    },
  }
}
