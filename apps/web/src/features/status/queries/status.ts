import 'server-only'

import { connection } from 'next/server'
import { logger } from '@/lib/logger'
import { createPublicClient } from '@/lib/supabase/public'
import { type PublicStatus, parsePublicStatus } from '../lib/status'

/**
 * The service status, read now (migration 26's `public_status()`, callable
 * with the publishable key). Deliberately uncached — a status page that lags
 * is worse than none — so it marks itself request-time with `connection()`
 * and must render inside Suspense. Null when it cannot be read.
 */
export async function getPublicStatus(): Promise<PublicStatus | null> {
  await connection()

  try {
    const { data, error } = await createPublicClient().rpc('public_status')
    if (error) {
      logger.error({ err: error.message }, 'public status could not be read')
      return null
    }
    const status = parsePublicStatus(data)
    if (!status) logger.error('public status had an unexpected shape')
    return status
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'public status could not be read',
    )
    return null
  }
}
