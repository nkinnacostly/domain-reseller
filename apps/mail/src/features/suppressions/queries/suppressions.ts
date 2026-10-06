import 'server-only'

import { createClient } from '@/lib/supabase/server'
import type { SuppressionReason, SuppressionSource } from '../lib/words'

/**
 * The account's suppression list (MAIL-SPEC §7.5, §10), read as the person:
 * RLS shows it to the account's members only (MR4: addresses are personal
 * data). Newest first, a page at a time, or one address looked up exactly.
 * Never logged (N13). A failed read is null (S11).
 */

export type Suppression = {
  id: number
  address: string
  reason: SuppressionReason
  source: SuppressionSource
  createdAt: string
}

export const SUPPRESSIONS_PAGE_SIZE = 50

const REASONS = new Set(['bounce', 'complaint', 'manual'])
const SOURCES = new Set(['ses', 'customer', 'admin'])

export function readSuppressions(rows: unknown): Suppression[] {
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row) => {
    const r = row as Record<string, unknown>
    if (
      typeof r.id !== 'number' ||
      typeof r.address !== 'string' ||
      !REASONS.has(String(r.reason)) ||
      !SOURCES.has(String(r.source))
    ) {
      return []
    }
    return [
      {
        id: r.id,
        address: r.address,
        reason: r.reason as SuppressionReason,
        source: r.source as SuppressionSource,
        createdAt: String(r.created_at ?? ''),
      },
    ]
  })
}

/** A search term as the list stores addresses: trimmed, lower-case; null when it is not one. */
export function searchTerm(value: string | undefined): string | null {
  const term = value?.trim().toLowerCase() ?? ''
  return term.length > 0 && term.length <= 320 ? term : null
}

export async function getSuppressions(
  accountId: string,
  { page = 1, search = null }: { page?: number; search?: string | null } = {},
): Promise<{ rows: Suppression[]; total: number } | null> {
  const supabase = await createClient()
  let query = supabase
    .from('suppressions')
    .select('id, address, reason, source, created_at', { count: 'exact' })
    .eq('account_id', accountId)
  if (search) query = query.eq('address', search)
  const from = (Math.max(page, 1) - 1) * SUPPRESSIONS_PAGE_SIZE
  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, from + SUPPRESSIONS_PAGE_SIZE - 1)
  // A page past the end (PostgREST's 416) is an empty page, not a failure.
  if (error) return error.code === 'PGRST103' ? { rows: [], total: 0 } : null
  return { rows: readSuppressions(data), total: count ?? 0 }
}
