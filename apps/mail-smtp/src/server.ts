import type { Database } from '@dr/db'
import { createClient } from '@supabase/supabase-js'
import { parseEnv } from './env'
import { startHealthServer } from './health'
import { createLogger } from './logger'
import { createRelay } from './relay'
import { createRelayStore } from './store'

/**
 * MyDomainsHub Mail's SMTP relay (MAIL-SPEC §6, "SMTP"), on Fly as its own
 * app (`fly deploy -c fly.smtp.toml`): Fly's proxy ends TLS on 465 and 2465
 * and hands plain SMTP to SMTP_PORT. It queues; the mail worker sends.
 *
 * Its heartbeat is `mail-worker:smtp`, so the admin health page lists it
 * beside the worker's loops and the "silent for 15 minutes" alert covers it
 * with no change in SQL.
 */
const env = parseEnv(process.env)
const log = createLogger(env.LOG_LEVEL)

const db = createClient<Database, 'mail'>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  db: { schema: 'mail' },
  auth: { autoRefreshToken: false, persistSession: false },
})
const store = createRelayStore(db)

const { server, counts } = createRelay({
  store,
  pepper: env.MAIL_API_KEY_PEPPER,
  log,
  hostname: env.SMTP_HOSTNAME,
  maxClients: env.SMTP_MAX_CLIENTS,
  relayId: env.MAIL_SMTP_ID,
})

let listening = false
server.on('error', (error) =>
  log.error({ err: error.name, code: (error as { code?: string }).code }, 'smtp server error'),
)
server.listen(env.SMTP_PORT, () => {
  listening = true
  log.info({ relay: env.MAIL_SMTP_ID, port: env.SMTP_PORT }, 'smtp relay started')
})

const health = startHealthServer(env.PORT, () => listening)

// Counts since the last beat, never an address: what the admin page shows.
const HEARTBEAT_MS = 60_000
let last = counts()
const beat = setInterval(() => {
  const now = counts()
  store
    .heartbeat('mail-worker:smtp', {
      everyMinutes: 1,
      connections: now.connections,
      accepted: now.accepted - last.accepted,
      refused: now.refused - last.refused,
    })
    .then(
      () => {
        last = now
      },
      (error: Error) => log.warn({ err: error.name }, 'smtp heartbeat failed'),
    )
}, HEARTBEAT_MS)

function shutdown(signal: string) {
  log.info({ signal }, 'smtp relay stopping')
  clearInterval(beat)
  listening = false
  server.close(() => {
    health.close()
    process.exit(0)
  })
}

process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))
