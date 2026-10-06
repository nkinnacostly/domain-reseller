import { bearerMatches } from '@/features/safety/lib/trigger'
import { applyDueTenantActions } from '@/features/safety/queries/apply'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'

/**
 * The worker asks here to apply queued SES-side pauses (MAIL-SPEC §7.4,
 * §4.3): it holds only the sender key; this app holds the manager key. Thin:
 * check the shared secret, apply what SQL has queued, answer the counts.
 */
const headers = { 'cache-control': 'no-store' }

export async function POST(request: Request) {
  if (!env.MAIL_SAFETY_SECRET) {
    return Response.json({ ok: false, error: 'not_configured' }, { status: 503, headers })
  }
  if (!bearerMatches(request.headers.get('authorization'), env.MAIL_SAFETY_SECRET)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401, headers })
  }
  try {
    const run = await applyDueTenantActions()
    return Response.json({ ok: true, ...run }, { headers })
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? error.message : 'error' },
      'applying tenant status changes failed',
    )
    return Response.json({ ok: false, error: 'failed' }, { status: 503, headers })
  }
}
