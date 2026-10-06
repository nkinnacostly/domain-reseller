import 'server-only'

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { dnsLookup } from '@/features/domains/queries/dns'
import { logger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/service'
import { runSesJobs } from '../lib/jobs'
import { SesNotConfigured, sesSetup } from '../lib/ses'
import { createJobsStore } from '../queries/store'

/**
 * POST /api/jobs/ses — the SES job route (MAIL-SPEC §4.1, §5, §7.2). pg_cron
 * calls it every five minutes and pg_net when an account is made (migration
 * 47), with the bearer token kept in Supabase Vault; `begin_ses_jobs` checks
 * it in SQL, so the token is never copied anywhere. The manager key lives
 * only here, on Vercel (§4.3). Answers JSON with counts only (N13).
 */

const NO_STORE = { 'cache-control': 'no-store' }

const answer = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: NO_STORE })

const bodySchema = z.object({ accountId: z.uuid().optional() }).catch({})

function bearer(header: string | null): string | null {
  const match = header?.match(/^Bearer\s+([\x21-\x7e]{16,200})$/)
  return match?.[1] ?? null
}

export async function handleSesJobs(request: Request): Promise<Response> {
  const token = bearer(request.headers.get('authorization'))
  if (!token) return answer(401, { ok: false, error: 'unauthorized' })

  let ses: ReturnType<typeof sesSetup>
  try {
    ses = sesSetup()
  } catch (error) {
    if (!(error instanceof SesNotConfigured)) throw error
    logger.error({ missing: error.missing }, 'ses jobs: SES is not configured')
    return answer(503, { ok: false, error: 'ses_not_configured' })
  }

  const store = createJobsStore(createServiceClient())
  try {
    const begun = await store.begin(token)
    if (!begun) return answer(401, { ok: false, error: 'unauthorized' })
    let body: unknown = {}
    try {
      body = await request.json()
    } catch {
      body = {}
    }
    const { accountId } = bodySchema.parse(body)
    const summary = await runSesJobs(
      { ses, store, lookup: dnsLookup(), worker: `jobs:${randomUUID().slice(0, 8)}` },
      begun,
      accountId ? { accountId } : {},
    )
    logger.info({ side: ses.side, ...summary }, 'ses jobs ran')
    return answer(200, { ok: true, side: ses.side, ...summary })
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? error.message.slice(0, 200) : 'unknown' },
      'ses jobs failed',
    )
    return answer(500, { ok: false, error: 'internal_error' })
  }
}
