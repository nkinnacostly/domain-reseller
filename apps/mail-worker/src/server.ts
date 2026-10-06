import type { Database } from '@dr/db'
import { createTenantSender, getSesAccount } from '@dr/shared/ses'
import { createClient } from '@supabase/supabase-js'
import { parseEnv } from './env'
import { healthStatus, startHealthServer } from './health'
import { createLogger } from './logger'
import { createPacer } from './pacing'
import { createQuotaWatch, QUOTA_HEARTBEAT } from './quota'
import { createSender } from './sender'
import { createMailStore } from './store'

/**
 * MyDomainsHub Mail's worker (MAIL-SPEC §3): the only process that calls
 * SES SendEmail, with the `mdm-sender` key. One machine on Fly
 * (`fly deploy --ha=false -c fly.mail.toml`): one pacing budget (MR8).
 */
const env = parseEnv(process.env)
const log = createLogger(env.LOG_LEVEL)

const db = createClient<Database, 'mail'>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  db: { schema: 'mail' },
  auth: { autoRefreshToken: false, persistSession: false },
})
const store = createMailStore(db)
const credentials = {
  region: env.MAIL_SES_REGION,
  accessKeyId: env.MAIL_SES_SENDER_ACCESS_KEY_ID,
  secretAccessKey: env.MAIL_SES_SENDER_SECRET_ACCESS_KEY,
}

const quota = createQuotaWatch({
  read: () => getSesAccount(credentials),
  holdFreeAt: env.MAIL_QUOTA_HOLD_FREE_AT,
  everyMs: env.MAIL_QUOTA_CHECK_MINUTES * 60_000,
  log,
  heartbeat: (detail) => store.heartbeat(QUOTA_HEARTBEAT, detail),
})

const sender = createSender({
  store,
  ses: createTenantSender(credentials),
  pacer: createPacer(env.MAIL_MAX_SEND_RATE),
  workerId: env.MAIL_WORKER_ID,
  batchSize: env.MAIL_CLAIM_BATCH,
  pollMs: env.MAIL_POLL_MS,
  log,
  paidOnly: quota.holdFree,
})

// Silent for a minute (sixty empty polls at the default) is a stuck loop.
const health = startHealthServer(env.PORT, () =>
  healthStatus(sender.lastRunAt(), Date.now(), Math.max(60_000, env.MAIL_POLL_MS * 10)),
)

quota.start()
sender.start()
log.info(
  { worker: env.MAIL_WORKER_ID, rate: env.MAIL_MAX_SEND_RATE, region: env.MAIL_SES_REGION },
  'mail worker started',
)

async function shutdown(signal: string) {
  log.info({ signal }, 'mail worker stopping')
  quota.stop()
  await sender.stop()
  health.close()
  process.exit(0)
}

process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))
