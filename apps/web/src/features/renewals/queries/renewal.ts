import 'server-only'

import type { TldPricing } from '@dr/shared'
import { checkoutOpenTo } from '@/features/checkout/lib/access'
import { type DomainDetail, getDomain } from '@/features/domains/queries/domains'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { env, requirePaymentEnv } from '@/lib/env'
import { createClient } from '@/lib/supabase/server'
import { type Renewability, renewability } from '../lib/renewal'

/** Order lines still being turned into a renewal: paid, and not yet settled. */
const IN_FLIGHT_LINES = ['pending', 'provisioning']
const PAID_ORDERS = ['paid', 'provisioning']

export type RenewalView = {
  domain: DomainDetail
  pricing: TldPricing | null
  vatPct: number
  /** The renewal price last paid for, or quoted when it was bought. */
  previousRenewalKobo: number | null
  paymentTestMode: boolean | null
  /** False while `CHECKOUT_ALLOWLIST` keeps payments to the listed accounts. */
  open: boolean
  check: Renewability
}

/** Which side payments run on, or null when they are not set up. */
export function paymentTestMode(): boolean | null {
  try {
    return requirePaymentEnv().testMode
  } catch {
    return null
  }
}

/**
 * Everything the renew page needs, read as the user (RLS): only their own
 * domain and their own orders are visible.
 */
export async function getRenewalView(domainName: string): Promise<RenewalView | null> {
  const domain = await getDomain(domainName)
  if (!domain) return null

  const supabase = await createClient()
  const [
    priced,
    { data: lines },
    {
      data: { user },
    },
  ] = await Promise.all([
    getPricedCatalogue(),
    supabase
      .from('order_items')
      .select('status, renewal_kobo, created_at, orders!inner(status)')
      .eq('domain_id', domain.id)
      .eq('item_type', 'renew')
      .order('created_at', { ascending: false }),
    supabase.auth.getUser(),
  ])

  const pricing = priced?.tlds.find((tld) => tld.tld === domain.tld) ?? null
  const renewals = lines ?? []
  const inProgress = renewals.some(
    (line) => IN_FLIGHT_LINES.includes(line.status) && PAID_ORDERS.includes(line.orders.status),
  )
  const lastRenewed = renewals.find((line) => line.status === 'completed')
  const testMode = paymentTestMode()

  return {
    domain,
    pricing,
    vatPct: priced?.vatPct ?? 0,
    previousRenewalKobo: lastRenewed
      ? Number(lastRenewed.renewal_kobo)
      : domain.promisedRenewalKobo,
    paymentTestMode: testMode,
    open: checkoutOpenTo(user?.email, env.CHECKOUT_ALLOWLIST),
    check: renewability(domain, {
      paymentTestMode: testMode,
      tldMaxPeriod: pricing?.maxPeriod ?? null,
      inProgress,
      now: new Date(),
    }),
  }
}
