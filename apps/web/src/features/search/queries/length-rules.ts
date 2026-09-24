import 'server-only'

import { cacheLife, cacheTag } from 'next/cache'
import { logger } from '@/lib/logger'
import { createPublicClient } from '@/lib/supabase/public'
import type { LengthRules } from '../lib/length'

/**
 * Per-extension length rules (FR-S9), for every extension whose catalogue
 * entry knows one. Missing columns mean "no rule": the supplier still judges
 * the name, so a failed read only costs the calls the rules would have saved.
 */
export async function getLengthRules(): Promise<LengthRules> {
  try {
    return await loadLengthRules()
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'length rules unavailable — the supplier will judge name lengths',
    )
    return {}
  }
}

/**
 * The cached read. Identical for every visitor, so it uses the cookie-free
 * client, and it lives under the `pricing` tag and lifetime like the
 * catalogue it comes from. Throws on a failed query, so a dropped connection
 * is never cached as "no rules".
 */
export async function loadLengthRules(): Promise<LengthRules> {
  'use cache'
  cacheTag('pricing')
  cacheLife('hours')
  const { data, error } = await createPublicClient()
    .from('tlds')
    .select('name, min_chars, max_chars')
    .eq('is_sellable', true)
    .or('min_chars.not.is.null,max_chars.not.is.null')
  if (error) throw new Error(`tlds: ${error.message}`)
  return Object.fromEntries(
    (data ?? []).map((row) => [row.name, { min: row.min_chars, max: row.max_chars }]),
  )
}
