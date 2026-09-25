import 'server-only'

import { cacheLife, cacheTag } from 'next/cache'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'

/**
 * Which sign-in providers Supabase Auth has switched on (FR-A1), read from
 * its public settings endpoint — so "Continue with Google" appears once the
 * provider is configured there, and never before (a button that fails is
 * worse than none). Cached for hours; a failed read throws, so it is never
 * the cached answer.
 */
async function loadProviders(): Promise<{ google: boolean }> {
  'use cache'
  cacheTag('auth-providers')
  cacheLife('hours')

  const response = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/settings`, {
    headers: { apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY },
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error(`auth settings: HTTP ${response.status}`)
  const body = (await response.json()) as { external?: { google?: unknown } }
  return { google: body.external?.google === true }
}

/** Whether to offer "Continue with Google". Unknown counts as no. */
export async function googleSignInAvailable(): Promise<boolean> {
  try {
    return (await loadProviders()).google
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'sign-in providers could not be read',
    )
    return false
  }
}
