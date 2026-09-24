import type { Database } from '@dr/db'
import type { TransactionRecord } from '@dr/shared'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { env } from '../env'

/**
 * The payment sweeper's view of the database (migration 18). Recording goes
 * through the same functions the web app uses, so a charge is recorded once
 * however many of the redirect, the webhook and the sweeper find it.
 */

const dueSchema = z.object({
  id: z.uuid(),
  tx_ref: z.string().min(1),
  total_kobo: z.coerce.number().int().nonnegative(),
  order_number: z.string(),
})

export type DueOrder = { id: string; txRef: string; totalKobo: number; orderNumber: string }

export type ChargeToRecord = {
  orderId: string
  providerReference: string
  amountKobo: number
  currency: string
  method: string
  raw: TransactionRecord
}

export type PaymentIncident = 'tx_ref_mismatch' | 'currency_mismatch' | 'unrecorded_payment'

export interface PaymentStore {
  /** Unpaid orders due a look, marked as looked at. */
  ordersToCheck(testMode: boolean, limit: number): Promise<DueOrder[]>
  recordPayment(charge: ChargeToRecord): Promise<void>
  recordUnderpayment(charge: ChargeToRecord): Promise<void>
  recordIncident(
    kind: PaymentIncident,
    orderId: string,
    providerReference: string,
    detail: Record<string, string | number>,
  ): Promise<void>
}

export function createPaymentStore(
  client: SupabaseClient<Database> = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SECRET_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  ),
): PaymentStore {
  const args = (charge: ChargeToRecord) => ({
    p_order_id: charge.orderId,
    p_provider_reference: charge.providerReference,
    p_amount_kobo: charge.amountKobo,
    p_currency: charge.currency,
    p_method: charge.method,
    p_raw: charge.raw,
  })

  return {
    async ordersToCheck(testMode, limit) {
      const { data, error } = await client.rpc('orders_to_check', {
        p_test_mode: testMode,
        p_limit: limit,
      })
      if (error) throw new Error(error.message)
      return (data ?? []).map((raw) => {
        const row = dueSchema.parse(raw)
        return {
          id: row.id,
          txRef: row.tx_ref,
          totalKobo: row.total_kobo,
          orderNumber: row.order_number,
        }
      })
    },
    async recordPayment(charge) {
      const { error } = await client.rpc('record_order_payment', args(charge))
      if (error) throw new Error(error.message)
    },
    async recordUnderpayment(charge) {
      const { error } = await client.rpc('record_underpayment', args(charge))
      if (error) throw new Error(error.message)
    },
    async recordIncident(kind, orderId, providerReference, detail) {
      const { error } = await client.rpc('record_payment_incident', {
        p_kind: kind,
        p_order_id: orderId,
        p_provider_reference: providerReference,
        p_detail: detail,
      })
      if (error) throw new Error(error.message)
    },
  }
}
