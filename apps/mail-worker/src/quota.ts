import type { SesQuota, SesResult } from '@dr/shared/ses'
import type { HeartbeatDetail } from './store'

/**
 * The SES account's 24-hour quota, read every few minutes (MAIL-SPEC §4.4):
 * past MAIL_QUOTA_HOLD_FREE_AT of it (80%), free and sandbox accounts wait
 * so paid ones — and the shop's own receipts — keep sending. A read that
 * fails changes nothing: the last answer holds, and none means no hold.
 */

type Log = {
  info(fields: object, message: string): void
  warn(fields: object, message: string): void
}

export type QuotaOptions = {
  read: () => Promise<SesResult<{ quota: SesQuota }>>
  holdFreeAt: number
  everyMs: number
  log: Log
  heartbeat: (detail: HeartbeatDetail) => Promise<void>
}

export const QUOTA_HEARTBEAT = 'mail-worker:quota'

export function createQuotaWatch(options: QuotaOptions) {
  const { read, holdFreeAt, everyMs, log, heartbeat } = options
  let holdFree = false
  let timer: NodeJS.Timeout | null = null

  async function check(): Promise<boolean> {
    const answer = await read()
    if (!answer.ok) {
      log.warn(
        { status: answer.status, code: answer.code },
        'SES quota not read; the last answer holds',
      )
      return holdFree
    }
    const { max24HourSend, sentLast24Hours, maxSendRate } = answer.quota
    const share = max24HourSend && sentLast24Hours !== null ? sentLast24Hours / max24HourSend : null
    const next = share !== null && share >= holdFreeAt
    if (next !== holdFree) {
      log.info(
        { share, holdFree: next },
        next ? 'SES day nearly spent: free accounts wait' : 'free accounts send again',
      )
    }
    holdFree = next
    await heartbeat({ max24HourSend, sentLast24Hours, maxSendRate, share, holdFree })
    return holdFree
  }

  return {
    check,
    holdFree: () => holdFree,
    start() {
      const tick = async () => {
        try {
          await check()
        } catch (error) {
          log.warn(
            { err: error instanceof Error ? error.message : 'error' },
            'SES quota check failed',
          )
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
