import 'server-only'

import type { LocalStatus, TldPricing } from '@dr/shared'
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

/** One domain in a bulk renewal: what it is, its price, and whether it can be renewed. */
export type BulkRenewalLine = {
  id: string
  domainName: string
  status: LocalStatus
  expiresAt: string | null
  pricing: TldPricing | null
  /** FR-RN7 — the renewal price last paid or promised, to say if it has gone up. */
  previousRenewalKobo: number | null
  check: Renewability
}

export type BulkRenewalView = {
  lines: BulkRenewalLine[]
  vatPct: number
  paymentTestMode: boolean | null
  open: boolean
}

/**
 * FR-P4, FR-P5 — the renew page for several domains, read as the user
 * (RLS): ids that are not theirs simply do not come back. Each domain is
 * judged by the same rules as the one-domain page (`renewability`).
 */
export async function getBulkRenewalView(ids: readonly string[]): Promise<BulkRenewalView> {
  const supabase = await createClient()
  const [
    priced,
    { data: domains, error },
    { data: lines },
    {
      data: { user },
    },
  ] = await Promise.all([
    getPricedCatalogue(),
    supabase
      .from('domains')
      .select(
        'id, domain_name, tld, source, test_mode, local_status, expires_at, order_items(renewal_kobo)',
      )
      .in('id', [...ids]),
    supabase
      .from('order_items')
      .select('domain_id, status, renewal_kobo, created_at, orders!inner(status)')
      .in('domain_id', [...ids])
      .eq('item_type', 'renew')
      .order('created_at', { ascending: false }),
    supabase.auth.getUser(),
  ])
  if (error) throw new Error('domains could not be read for renewal')

  const testMode = paymentTestMode()
  const now = new Date()
  const byId = new Map((domains ?? []).map((domain) => [domain.id, domain]))
  return {
    // In the order asked for, so the page lists them as they were ticked.
    lines: ids.flatMap((id) => {
      const domain = byId.get(id)
      if (!domain) return []
      const pricing = priced?.tlds.find((tld) => tld.tld === domain.tld) ?? null
      const renewals = (lines ?? []).filter((line) => line.domain_id === domain.id)
      const inProgress = renewals.some(
        (line) => IN_FLIGHT_LINES.includes(line.status) && PAID_ORDERS.includes(line.orders.status),
      )
      const lastRenewed = renewals.find((line) => line.status === 'completed')
      const promised = domain.order_items?.renewal_kobo
      return [
        {
          id: domain.id,
          domainName: domain.domain_name,
          status: domain.local_status as LocalStatus,
          expiresAt: domain.expires_at,
          pricing,
          previousRenewalKobo: lastRenewed
            ? Number(lastRenewed.renewal_kobo)
            : promised === undefined || promised === null
              ? null
              : Number(promised),
          check: renewability(
            {
              source: domain.source as 'registration' | 'transfer' | 'demo',
              status: domain.local_status as LocalStatus,
              testMode: domain.test_mode,
              expiresAt: domain.expires_at,
            },
            {
              paymentTestMode: testMode,
              renewPeriods: pricing?.renewPeriods ?? null,
              inProgress,
              now,
            },
          ),
        },
      ]
    }),
    vatPct: priced?.vatPct ?? 0,
    paymentTestMode: testMode,
    open: checkoutOpenTo(user?.email, env.CHECKOUT_ALLOWLIST),
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
      renewPeriods: pricing?.renewPeriods ?? null,
      inProgress,
      now: new Date(),
    }),
  }
}
