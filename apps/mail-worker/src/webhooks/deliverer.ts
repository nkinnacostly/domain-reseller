import { WEBHOOK_USER_AGENT } from '@dr/shared/mail'
import { openWebhookSecret, webhookHeaders } from '@dr/shared/webhooks'
import type { HeartbeatDetail } from '../store'
import type { Attempt, ClaimedDelivery, UnreadableDelivery, WebhookStore } from './store'
import type { Transport } from './transport'

/**
 * The webhook loop (MAIL-SPEC §3, §6, MR6): the worker's second job, beside
 * the send loop.
 *
 *   claim   — claim_webhook_deliveries: due deliveries to enabled endpoints.
 *   sign    — the endpoint's secret, opened in memory with
 *             MAIL_WEBHOOK_SECRET_KEY, signs `id.timestamp.body` the Standard
 *             Webhooks way (webhook-id, webhook-timestamp, webhook-signature).
 *             The webhook-id is the message's: a resend carries the same one,
 *             so a receiver that has seen it can skip it.
 *   post    — over the guarded transport (public addresses only, 10 s).
 *   record  — record_webhook_attempt: SQL decides delivered, retry with
 *             backoff for 24 hours, give up, or turn the endpoint off after
 *             three days without a 2xx.
 *   beat    — a heartbeat after every run that did something, and every 30 s
 *             while idle (§11: "the worker's webhook loop").
 *
 * A few deliveries at once, so one slow endpoint does not hold up the rest.
 * Logs carry ids, statuses and codes — never a URL's path, a payload or a
 * secret (N13, MR4).
 */

type Log = {
  info(fields: object, message: string): void
  warn(fields: object, message: string): void
  error(fields: object, message: string): void
}

export type DelivererOptions = {
  store: WebhookStore
  transport: Transport
  /** MAIL_WEBHOOK_SECRET_KEY, 32 bytes. */
  key: Uint8Array
  workerId: string
  batchSize: number
  concurrency: number
  pollMs: number
  log: Log
  heartbeat: (detail: HeartbeatDetail) => Promise<void>
  /** e2e only: deliver this test account's deliveries, and nobody else's. */
  accountId?: string
  sleep?: (ms: number) => Promise<void>
  clock?: () => number
  now?: () => Date
  heartbeatEveryMs?: number
}

export type DeliveryRun = {
  claimed: number
  delivered: number
  failed: number
  unreadable: number
}

export const WEBHOOK_HEARTBEAT = 'mail-worker:webhooks'
export const USER_AGENT = WEBHOOK_USER_AGENT

const isUnreadable = (claim: ClaimedDelivery | UnreadableDelivery): claim is UnreadableDelivery =>
  'unreadable' in claim

export function createWebhookDeliverer(options: DelivererOptions) {
  const {
    store,
    transport,
    key,
    workerId,
    batchSize,
    concurrency,
    pollMs,
    log,
    heartbeat,
    accountId,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    clock = Date.now,
    now = () => new Date(),
    heartbeatEveryMs = 30_000,
  } = options

  let lastRunAt: number | null = null
  let lastBeatAt: number | null = null

  async function deliverOne(delivery: ClaimedDelivery, run: DeliveryRun): Promise<void> {
    const fields = {
      deliveryId: delivery.id,
      webhookId: delivery.webhookId,
      messageId: delivery.messageId,
      attempt: delivery.attempt,
    }
    const secret = await openWebhookSecret(key, delivery.secretSealed, delivery.accountId)
    let attempt: Attempt
    if (!secret) {
      attempt = { status: null, error: 'secret_unreadable', response: null, durationMs: null }
      run.unreadable += 1
      log.error(fields, 'a webhook secret could not be opened with MAIL_WEBHOOK_SECRET_KEY')
    } else {
      const body = JSON.stringify(delivery.payload)
      const signed = await webhookHeaders(secret, delivery.messageId, body, now())
      const result = await transport({
        url: delivery.url,
        headers: {
          ...signed,
          'content-type': 'application/json',
          'user-agent': USER_AGENT,
        },
        body,
      })
      attempt = result
      const ok = result.status !== null && result.status >= 200 && result.status < 300
      if (ok) run.delivered += 1
      else {
        run.failed += 1
        log.warn(
          { ...fields, status: result.status, error: result.error },
          'a webhook delivery was not accepted; SQL decides when it goes again',
        )
      }
    }
    const recorded = await store.record(delivery.id, workerId, attempt)
    if (!recorded) log.error(fields, 'the claim had passed to another worker; attempt not recorded')
  }

  async function runOnce(): Promise<DeliveryRun> {
    const run: DeliveryRun = { claimed: 0, delivered: 0, failed: 0, unreadable: 0 }
    const claims = await store.claim(workerId, batchSize, accountId)
    run.claimed = claims.length
    const queue = [...claims]
    const lane = async () => {
      for (let claim = queue.shift(); claim; claim = queue.shift()) {
        if (isUnreadable(claim)) {
          log.error({ deliveryId: claim.id }, 'a claimed delivery could not be read; it fails')
          run.unreadable += 1
          await store
            .record(claim.id, workerId, {
              status: null,
              error: 'secret_unreadable',
              response: null,
              durationMs: null,
            })
            .catch(() => undefined)
          continue
        }
        try {
          await deliverOne(claim, run)
        } catch (error) {
          // The database could not take the answer: the claim lapses after
          // five minutes and the delivery is tried again (at-least-once).
          log.error(
            { deliveryId: claim.id, err: error instanceof Error ? error.message : 'error' },
            'a webhook attempt could not be recorded',
          )
        }
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane))
    const at = clock()
    if (run.claimed > 0 || lastBeatAt === null || at - lastBeatAt >= heartbeatEveryMs) {
      await heartbeat({ ...run })
      lastBeatAt = at
    }
    if (run.claimed > 0) log.info({ ...run }, 'webhooks delivered')
    lastRunAt = at
    return run
  }

  let running = false
  let current: Promise<void> | null = null

  async function loop(): Promise<void> {
    while (running) {
      let full = false
      try {
        const run = await runOnce()
        full = run.claimed >= batchSize
      } catch (error) {
        log.error({ err: error instanceof Error ? error.message : 'error' }, 'webhook run failed')
      }
      if (running && !full) await sleep(pollMs)
    }
  }

  return {
    runOnce,
    lastRunAt: () => lastRunAt,
    start() {
      if (running) return
      running = true
      current = loop()
    },
    /** Finishes the deliveries in hand, then stops. */
    async stop() {
      running = false
      await current
    },
  }
}

export type WebhookDeliverer = ReturnType<typeof createWebhookDeliverer>
