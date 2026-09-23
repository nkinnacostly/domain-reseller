import { hostname } from 'node:os'
import { serve } from '@hono/node-server'
import { createApp } from './app'
import { getDnaWriteClient } from './dna/client'
import { env } from './env'
import { logger } from './lib/logger'
import { createDnaRegistrar } from './provisioning/registrar'
import { createSupabaseStore } from './provisioning/store'
import { createWorker } from './provisioning/worker'
import { createReconciler } from './reconcile/reconciler'
import { createReconcileStore } from './reconcile/store'

/**
 * Registrar gateway — PRD §6.4 (ADR-004).
 *
 * The ONLY process that holds DomainNameAPI credentials and the only one that
 * makes outbound calls to them. Deploy on infrastructure with a STATIC EGRESS IP;
 * the supplier allowlists it (error API_301).
 *
 * Responsibilities: credential custody · rate limiting · retry with backoff ·
 * idempotency · circuit breaking · audit logging of every supplier call ·
 * working the provisioning queue (§13.6).
 */
const app = createApp()

const server = serve({ fetch: app.fetch, port: env.PORT }, ({ port }) => {
  logger.info(
    { port, dnaEnv: env.DNA_ENV, writes: env.DNA_WRITE_ENV },
    'registrar gateway listening',
  )
})

const target = env.DNA_WRITE_ENV === 'off' ? null : env.DNA_WRITE_ENV
const store = target ? createSupabaseStore() : null
const worker =
  target && store
    ? createWorker({
        store,
        testMode: target === 'ote',
        workerId: `${hostname()}:${process.pid}`,
        pollMs: env.PROVISION_POLL_MS,
        log: logger,
        registrarFor: (job) =>
          createDnaRegistrar({
            client: getDnaWriteClient(target),
            environment: target,
            audit: (call) => store.recordCall(job.id, target, call),
          }),
      })
    : null

// §13.5: the registry is read on a schedule, against the same side the
// worker writes to. Read-only at the supplier.
const reconciler =
  target && store
    ? createReconciler({
        store: createReconcileStore(),
        reader: createDnaRegistrar({
          client: getDnaWriteClient(target),
          environment: target,
          audit: (call) => store.recordCall(null, target, call),
        }),
        testMode: target === 'ote',
        everyMs: env.RECONCILE_EVERY_MINUTES * 60_000,
        log: logger,
      })
    : null

if (worker) {
  worker.start()
  logger.info(
    { target, orders: target === 'ote' ? 'test payments' : 'live payments' },
    'provisioning worker started',
  )
}
reconciler?.start()

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  await Promise.all([worker?.stop(), reconciler?.stop()])
  server.close()
  process.exit(0)
}
process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))

export { app }
