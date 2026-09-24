import 'server-only'

import type { TldPricing } from '@dr/shared'
import { checkoutOpenTo } from '@/features/checkout/lib/access'
import type { RegistrantForm } from '@/features/checkout/lib/contact'
import { defaultRegistrant } from '@/features/checkout/queries/registrant'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { paymentTestMode } from '@/features/renewals/queries/renewal'
import { env } from '@/lib/env'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { evaluateTransfer, type TransferVerdict } from '../lib/eligibility'
import { parseTransferQuery, TRANSFER_QUERY_MESSAGES } from '../lib/href'
import { canStartTransfer, HELD_HERE, TRANSFER_UNDER_WAY, takesTransfers } from '../lib/start'
import { lookupDomain } from './rdap-lookup'

/**
 * Everything the transfer checkout needs (PRD FR-T1, FR-T2), and every reason
 * it cannot offer a payment — each one a state the page explains. The same
 * checks run again in `placeTransfer`, with the supplier's check of the code
 * added, before any money moves.
 */
export type TransferCheckoutView =
  | { state: 'invalid'; message: string }
  | { state: 'unpriced' }
  | { state: 'not-offered'; domain: string; tld: string }
  | { state: 'payments-off' }
  | { state: 'closed' }
  | { state: 'yours'; domain: string }
  | { state: 'held'; domain: string }
  | { state: 'under-way'; domain: string }
  | { state: 'blocked'; domain: string; reason: string; verdict: TransferVerdict }
  | {
      state: 'ready'
      domain: string
      tld: string
      pricing: TldPricing & { transfer: NonNullable<TldPricing['transfer']> }
      vatPct: number
      verdict: TransferVerdict
      registrant: RegistrantForm
      testMode: boolean
    }

export async function getTransferCheckoutView(raw: string): Promise<TransferCheckoutView | null> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const query = parseTransferQuery(raw)
  if (!query.ok) return { state: 'invalid', message: TRANSFER_QUERY_MESSAGES[query.reason] }
  const { domain, tld } = query

  const service = createServiceClient()
  const [priced, { data: tldRow }] = await Promise.all([
    getPricedCatalogue(),
    service.from('tlds').select('is_transferable, transfer_usd').eq('name', tld).maybeSingle(),
  ])
  if (!priced) return { state: 'unpriced' }
  const pricing = priced.tlds.find((entry) => entry.tld === tld)
  // N5b: no transfer price, no transfer — never a guessed one.
  if (!pricing?.transfer || !tldRow || !takesTransfers(tldRow)) {
    return { state: 'not-offered', domain, tld }
  }

  const testMode = paymentTestMode()
  if (testMode === null) return { state: 'payments-off' }
  if (!checkoutOpenTo(user.email, env.CHECKOUT_ALLOWLIST)) return { state: 'closed' }

  // Ours already, on this side: the account's own (RLS), or anyone's here.
  const [{ data: own }, { data: heldHere }] = await Promise.all([
    supabase
      .from('domains')
      .select('local_status')
      .eq('domain_name', domain)
      .eq('test_mode', testMode),
    service
      .from('domains')
      .select('id')
      .eq('domain_name', domain)
      .eq('test_mode', testMode)
      .neq('source', 'demo')
      .in('local_status', [...HELD_HERE])
      .limit(1),
  ])
  const statuses = (own ?? []).map((row) => row.local_status as string)
  if (statuses.some((status) => (HELD_HERE as readonly string[]).includes(status))) {
    return { state: 'yours', domain }
  }
  if (statuses.some((status) => (TRANSFER_UNDER_WAY as readonly string[]).includes(status))) {
    return { state: 'under-way', domain }
  }
  if ((heldHere ?? []).length > 0) return { state: 'held', domain }

  const verdict = evaluateTransfer({
    domain,
    tld,
    offer: 'offered',
    lookup: await lookupDomain(domain),
    now: new Date(),
  })
  const start = canStartTransfer(verdict)
  if (!start.ok) return { state: 'blocked', domain, reason: start.reason, verdict }

  return {
    state: 'ready',
    domain,
    tld,
    pricing: { ...pricing, transfer: pricing.transfer },
    vatPct: priced.vatPct,
    verdict,
    registrant: await defaultRegistrant(supabase, user),
    testMode,
  }
}
