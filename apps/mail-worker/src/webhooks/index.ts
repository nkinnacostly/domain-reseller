import { webhookSealKey } from '@dr/shared/webhooks'
import type { Env } from '../env'
import type { HeartbeatDetail, MailClient } from '../store'
import { createWebhookDeliverer, WEBHOOK_HEARTBEAT, type WebhookDeliverer } from './deliverer'
import { createWebhookStore } from './store'
import { createTransport } from './transport'

type Log = Parameters<typeof createWebhookDeliverer>[0]['log']

/**
 * The webhook loop as the worker runs it (MAIL-SPEC §6): built from the
 * environment, or not at all when MAIL_WEBHOOK_SECRET_KEY is missing — then
 * it says so once and the send loop carries on alone.
 */
export function webhookLoop(
  env: Env,
  db: MailClient,
  log: Log,
  heartbeat: (name: string, detail: HeartbeatDetail) => Promise<void>,
): WebhookDeliverer | null {
  const key = webhookSealKey(env.MAIL_WEBHOOK_SECRET_KEY)
  if (!key) {
    log.warn({}, 'webhook deliveries are off: MAIL_WEBHOOK_SECRET_KEY is not 32 bytes of base64')
    return null
  }
  return createWebhookDeliverer({
    store: createWebhookStore(db),
    transport: createTransport(),
    key,
    workerId: env.MAIL_WORKER_ID,
    batchSize: env.MAIL_WEBHOOK_BATCH,
    concurrency: env.MAIL_WEBHOOK_CONCURRENCY,
    pollMs: env.MAIL_WEBHOOK_POLL_MS,
    log,
    heartbeat: (detail) => heartbeat(WEBHOOK_HEARTBEAT, detail),
  })
}
