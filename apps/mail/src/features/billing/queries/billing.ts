import 'server-only'

import { cache } from 'react'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'
import { type Invoice, type InvoiceSummary, readInvoice, readInvoiceSummary } from '../lib/invoice'
import { type BillingOverview, readBillingOverview } from '../lib/overview'

/**
 * Billing's reads, as the person (RLS; migration 50): the overview through
 * `billing_overview`, invoices and checkouts through their policies (owners
 * and admins). Each part fails on its own: null is the page's error state for
 * that part (S11), never an empty list or a zero. A read whose connection
 * dropped before any answer is asked once more by the client itself
 * (`@/lib/supabase/retry`), not here.
 */

/** Once per request: the dashboard's banner and the billing page both need it. */
export const getBillingOverview = cache(
  async (accountId: string): Promise<BillingOverview | null> => {
    const supabase = await createClient()
    const { data, error } = await supabase.rpc('billing_overview', { p_account_id: accountId })
    if (error) {
      logger.error({ code: error.code, err: error.message }, 'billing overview could not be read')
      return null
    }
    return readBillingOverview(data)
  },
)

export const INVOICES_SHOWN = 24

export async function listInvoices(accountId: string): Promise<InvoiceSummary[] | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('invoices')
    .select('id, number, test_mode, issued_at, plan_name, period_start, period_end, total_kobo')
    .eq('account_id', accountId)
    .order('issued_at', { ascending: false })
    .limit(INVOICES_SHOWN)
  if (error) {
    logger.error({ code: error.code }, 'invoices could not be read')
    return null
  }
  return (data ?? []).flatMap((row) => readInvoiceSummary(row) ?? [])
}

/** One invoice, if the person may see it (`undefined`: it could not be read). */
export async function getInvoice(id: string): Promise<Invoice | null | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const supabase = await createClient()
  const { data, error } = await supabase.from('invoices').select('*').eq('id', id).maybeSingle()
  if (error) {
    logger.error({ code: error.code }, 'invoice could not be read')
    return undefined
  }
  return data ? readInvoice(data) : null
}

export type ReturnCheckout = { id: string; accountId: string; txRef: string; status: string }

/** The checkout Flutterwave sent someone back from, if they may see it. */
export async function getCheckout(id: string): Promise<ReturnCheckout | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('checkouts')
    .select('id, account_id, tx_ref, status')
    .eq('id', id)
    .maybeSingle()
  if (error || !data) return null
  return { id: data.id, accountId: data.account_id, txRef: data.tx_ref, status: data.status }
}
