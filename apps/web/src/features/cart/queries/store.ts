import 'server-only'

import type { Database } from '@dr/db/types'
import { cookies } from 'next/headers'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import type { StoredLine } from '../lib/lines'
import { CART_COOKIE, hashCartToken } from '../lib/token'

/**
 * Cart persistence (FR-C1).
 *
 * Every read and write here uses the secret key, scoped by hand to one cart
 * whose owner was established first: the verified session, or the anonymous
 * cookie token. Anonymous carts cannot use RLS (there is no user), and cart
 * lines carry prices the browser must never write (migration 09), so one path
 * serves both — and every query below names the cart it touches.
 */

export type Owner = { kind: 'user'; userId: string } | { kind: 'anon'; tokenHash: string }

const LINE_COLUMNS =
  'id, domain, tld, period_years, privacy, auto_renew, quoted_total_kobo, quoted_renewal_kobo, quoted_at'

function toLine(row: {
  id: string
  domain: string
  tld: string
  period_years: number
  privacy: boolean
  auto_renew: boolean
  quoted_total_kobo: number
  quoted_renewal_kobo: number
  quoted_at: string
}): StoredLine {
  return {
    id: row.id,
    domain: row.domain,
    tld: row.tld,
    periodYears: row.period_years,
    privacy: row.privacy,
    autoRenew: row.auto_renew,
    quotedTotalKobo: Number(row.quoted_total_kobo),
    quotedRenewalKobo: Number(row.quoted_renewal_kobo),
    quotedAt: row.quoted_at,
  }
}

/** Who is shopping: the signed-in user, else the anonymous token, else nobody yet. */
export async function currentOwner(): Promise<{ owner: Owner | null; anonToken: string | null }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const anonToken = (await cookies()).get(CART_COOKIE)?.value ?? null

  if (user) return { owner: { kind: 'user', userId: user.id }, anonToken }
  if (anonToken) return { owner: { kind: 'anon', tokenHash: hashCartToken(anonToken) }, anonToken }
  return { owner: null, anonToken: null }
}

export async function findCartId(owner: Owner): Promise<string | null> {
  const query = createServiceClient().from('carts').select('id')
  const { data } = await (owner.kind === 'user'
    ? query.eq('user_id', owner.userId)
    : query.eq('anon_token_hash', owner.tokenHash)
  ).maybeSingle()
  return data?.id ?? null
}

export async function findOrCreateCartId(owner: Owner): Promise<string> {
  const existing = await findCartId(owner)
  if (existing) return existing

  const row: Database['public']['Tables']['carts']['Insert'] =
    owner.kind === 'user' ? { user_id: owner.userId } : { anon_token_hash: owner.tokenHash }
  const { data, error } = await createServiceClient()
    .from('carts')
    .insert(row)
    .select('id')
    .single()
  if (data) return data.id
  // Two requests raced to create it; the unique owner column kept one.
  const again = await findCartId(owner)
  if (again) return again
  throw error ?? new Error('Could not create cart')
}

export async function loadLines(cartId: string): Promise<StoredLine[]> {
  const { data, error } = await createServiceClient()
    .from('cart_items')
    .select(LINE_COLUMNS)
    .eq('cart_id', cartId)
    .order('created_at')
  if (error) throw error
  return (data ?? []).map(toLine)
}

export async function countLines(cartId: string): Promise<number> {
  const { count } = await createServiceClient()
    .from('cart_items')
    .select('id', { count: 'exact', head: true })
    .eq('cart_id', cartId)
  return count ?? 0
}

export type NewLine = {
  domain: string
  tld: string
  periodYears: number
  quotedTotalKobo: number
  quotedRenewalKobo: number
  quotedFxRateId: string
}

/** Adds a line; adding a domain already in the cart is a no-op, not an error. */
export async function insertLine(cartId: string, line: NewLine): Promise<void> {
  const { error } = await createServiceClient().from('cart_items').upsert(
    {
      cart_id: cartId,
      domain: line.domain,
      tld: line.tld,
      period_years: line.periodYears,
      quoted_total_kobo: line.quotedTotalKobo,
      quoted_renewal_kobo: line.quotedRenewalKobo,
      quoted_fx_rate_id: line.quotedFxRateId,
    },
    { onConflict: 'cart_id,domain', ignoreDuplicates: true },
  )
  if (error) throw error
}

export type LinePatch = Partial<{
  period_years: number
  privacy: boolean
  auto_renew: boolean
  quoted_total_kobo: number
  quoted_renewal_kobo: number
  quoted_fx_rate_id: string
  quoted_at: string
}>

export async function updateLine(cartId: string, lineId: string, patch: LinePatch): Promise<void> {
  const { error } = await createServiceClient()
    .from('cart_items')
    .update(patch)
    .eq('cart_id', cartId)
    .eq('id', lineId)
  if (error) throw error
}

export async function deleteLine(cartId: string, lineId: string): Promise<void> {
  const { error } = await createServiceClient()
    .from('cart_items')
    .delete()
    .eq('cart_id', cartId)
    .eq('id', lineId)
  if (error) throw error
}

/**
 * Moves an anonymous cart into the user's on sign-in (FR-C1). Lines keep
 * their quotes; a domain already in the user's cart keeps the user's line.
 * One transaction in the database (migration 10), so parallel renders after
 * sign-in never see a half-merged cart. Idempotent — safe on every access.
 */
export async function mergeAnonymousCart(anonToken: string, userId: string): Promise<void> {
  const { error } = await createServiceClient().rpc('merge_anonymous_cart', {
    p_token_hash: hashCartToken(anonToken),
    p_user_id: userId,
  })
  // The anonymous cart survives a failed merge, so nothing is lost; the next
  // cart access tries again.
  if (error) logger.error({ err: error }, 'cart merge failed')
}
