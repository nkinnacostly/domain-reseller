import type { Json } from '@dr/db'
import { z } from 'zod'
import type { MailClient } from '../store'
import type { Reading } from './cloudwatch'

/**
 * The worker's safety run, every 15 minutes (MAIL-SPEC §7.4, §7.8, §11):
 *
 *   read    — the SES account's reputation from CloudWatch (sender key).
 *   judge   — mail.run_safety_checks: the reading kept, and every sending
 *             account judged on its last 7 days against our levels; a pause
 *             stops our own gate at once and queues SES's side.
 *   ping    — while SES changes wait, ask apps/mail (which holds the manager
 *             key) to apply them: POST /api/safety/apply with the shared
 *             secret. It applies only what SQL has queued.
 *   beat    — `mail-worker:safety`, saying it beats every 15 minutes, so its
 *             silence is alerted on after 30.
 *
 * A failed read is recorded as such and the accounts are still judged; a
 * failed ping leaves the changes queued, our gate holding, and the alert
 * after 15 minutes. Logs carry counts and codes only (N13).
 */

type Log = {
  info(fields: object, message: string): void
  warn(fields: object, message: string): void
}

export const SAFETY_HEARTBEAT = 'mail-worker:safety'

export type SafetyRun = {
  reading: Reading['outcome']
  evaluated: number
  paused: number
  openWarnings: number
  pendingTenantActions: number
  pinged: 'ok' | 'failed' | 'not_configured' | 'not_needed'
}

const runAnswer = z.object({
  evaluated: z.number().int().nonnegative(),
  paused: z.number().int().nonnegative(),
  openWarnings: z.number().int().nonnegative(),
  pendingTenantActions: z.number().int().nonnegative(),
})

export type SafetyStore = {
  run(reading: Reading): Promise<z.infer<typeof runAnswer>>
  heartbeat(detail: { [key: string]: Json }): Promise<void>
}

export function createSafetyStore(client: MailClient): SafetyStore {
  return {
    async run(reading) {
      const args =
        reading.outcome === 'ok'
          ? {
              p_outcome: 'ok',
              ...(reading.bouncePpm === null ? {} : { p_bounce_ppm: reading.bouncePpm }),
              ...(reading.complaintPpm === null ? {} : { p_complaint_ppm: reading.complaintPpm }),
              ...(reading.metricAt ? { p_metric_at: reading.metricAt } : {}),
            }
          : { p_outcome: reading.outcome }
      const { data, error } = await client.rpc('run_safety_checks', args)
      if (error) throw new Error(`run_safety_checks failed (${error.code ?? 'unknown'})`)
      const parsed = runAnswer.safeParse(data)
      if (!parsed.success) throw new Error('run_safety_checks answered an unexpected shape')
      return parsed.data
    },
    async heartbeat(detail) {
      const { error } = await client
        .schema('public')
        .rpc('record_heartbeat', { p_name: SAFETY_HEARTBEAT, p_test_mode: false, p_detail: detail })
      if (error) throw new Error(`record_heartbeat failed (${error.code ?? 'unknown'})`)
    },
  }
}

export type Ping = () => Promise<'ok' | 'failed' | 'not_configured'>

/** POST /api/safety/apply on apps/mail with the shared secret; never a body. */
export function createApplyPing(options: {
  appUrl: string | undefined
  secret: string | undefined
  fetch?: typeof fetch
  timeoutMs?: number
}): Ping {
  const { appUrl, secret, fetch: send = fetch } = options
  return async () => {
    if (!appUrl || !secret) return 'not_configured'
    try {
      const response = await send(new URL('/api/safety/apply', appUrl).toString(), {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
      })
      return response.ok ? 'ok' : 'failed'
    } catch {
      return 'failed'
    }
  }
}

export function createSafetyJob(options: {
  read: () => Promise<Reading>
  store: SafetyStore
  ping: Ping
  everyMs: number
  log: Log
}) {
  const { read, store, ping, everyMs, log } = options
  let timer: NodeJS.Timeout | null = null
  const everyMinutes = Math.round(everyMs / 60_000)

  async function check(): Promise<SafetyRun> {
    let reading: Reading
    try {
      reading = await read()
    } catch {
      reading = { outcome: 'failed', status: null, code: null }
    }
    if (reading.outcome === 'failed') {
      log.warn({ status: reading.status, code: reading.code }, 'CloudWatch reputation not read')
    }
    const answer = await store.run(reading)
    const pinged = answer.pendingTenantActions > 0 ? await ping() : 'not_needed'
    if (pinged === 'failed' || pinged === 'not_configured') {
      log.warn(
        { pending: answer.pendingTenantActions, pinged },
        'SES pauses wait for apps/mail to apply them',
      )
    }
    const run: SafetyRun = { reading: reading.outcome, ...answer, pinged }
    if (answer.paused > 0) log.warn({ paused: answer.paused }, 'accounts paused by our threshold')
    await store.heartbeat({
      everyMinutes,
      reading: reading.outcome,
      evaluated: answer.evaluated,
      paused: answer.paused,
      openWarnings: answer.openWarnings,
      pendingTenantActions: answer.pendingTenantActions,
      pinged,
    })
    return run
  }

  return {
    check,
    start() {
      const tick = async () => {
        try {
          await check()
        } catch (error) {
          log.warn({ err: error instanceof Error ? error.message : 'error' }, 'safety run failed')
        }
        timer = setTimeout(tick, everyMs)
      }
      void tick()
    },
    stop() {
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
