import 'server-only'

import { logger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/service'
import { sweepDuplicateSubscriptions } from './duplicates'
import { paymentsConfigured, requireBillingEnv } from './env'

/**
 * POST /api/jobs/billing — the hourly look for duplicate Flutterwave
 * subscriptions (MAIL-SPEC §8; migration 56). pg_cron calls it at :47 through
 * pg_net, with the bearer token migration 47 keeps in Supabase Vault;
 * `begin_billing_jobs` checks it in SQL, so the token is never copied
 * anywhere. Flutterwave's key lives only here, on Vercel. Answers JSON with
 * counts only (N13).
 */

const NO_STORE = { 'cache-control': 'no-store' }

const answer = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: NO_STORE })

function bearer(header: string | null): string | null {
  const match = header?.match(/^Bearer\s+([\x21-\x7e]{16,200})$/)
  return match?.[1] ?? null
}

export async function handleBillingJobs(request: Request): Promise<Response> {
  const token = bearer(request.headers.get('authorization'))
  if (!token) return answer(401, { ok: false, error: 'unauthorized' })
  // Not on sale here: no key to ask Flutterwave with, and nothing it could have started.
  if (!paymentsConfigured()) return answer(503, { ok: false, error: 'billing_not_configured' })

  try {
    const settings = requireBillingEnv()
    const sweep = await sweepDuplicateSubscriptions(createServiceClient(), settings, token)
    if (!sweep) return answer(401, { ok: false, error: 'unauthorized' })
    logger.info({ testMode: settings.testMode, ...sweep }, 'billing jobs ran')
    return answer(200, { ok: true, ...sweep })
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? error.message.slice(0, 200) : 'unknown' },
      'billing jobs failed',
    )
    return answer(500, { ok: false, error: 'internal_error' })
  }
}
