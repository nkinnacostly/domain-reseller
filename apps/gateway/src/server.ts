import { hostname } from 'node:os'
import { serve } from '@hono/node-server'
import { createAlertMonitor } from './alerts/monitor'
import { createAlertStore } from './alerts/store'
import { createTelegramNotifier } from './alerts/telegram'
import { createApp } from './app'
import { getDnaWriteClient } from './dna/client'
import { env } from './env'
import { logger } from './lib/logger'
import { supplierSlots } from './lib/semaphore'
import { checkPayment } from './payments/charge-check'
import { createFlutterwave } from './payments/flutterwave'
import { createPaymentStore } from './payments/store'
import { createPaymentSweeper } from './payments/sweeper'
import { createDnaRegistrar } from './provisioning/registrar'
import { createSupabaseStore } from './provisioning/store'
import { createWorker } from './provisioning/worker'
import { createReconciler } from './reconcile/reconciler'
import { createReconcileStore } from './reconcile/store'
import { createRefunder } from './refunds/refunder'
import { createRefundStore } from './refunds/store'

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

// This side's Flutterwave key: to confirm a charge before registering, to
// refund, and to find lost payments. env.ts requires it whenever writes are on.
const flutterwave =
  target && env.FLUTTERWAVE_SECRET_KEY
    ? createFlutterwave({
        secretKey: env.FLUTTERWAVE_SECRET_KEY,
        baseUrl: env.FLUTTERWAVE_API_URL,
      })
    : null

const worker =
  target && store && flutterwave
    ? createWorker({
        store,
        checkPayment: (job) => checkPayment(flutterwave, job.payment),
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
        // PRD E9: the same registrar; its transfer calls are recorded without the code.
        transfersFor: (job) =>
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

// FR-R3 / L15: refunds for this side, with this side's Flutterwave key.
const refunder =
  target && store && flutterwave
    ? createRefunder({
        store: createRefundStore(),
        flutterwave,
        lookup: (domainName) =>
          createDnaRegistrar({
            client: getDnaWriteClient(target),
            environment: target,
            audit: (call) => store.recordCall(null, target, call),
          }).lookup(domainName),
        testMode: target === 'ote',
        workerId: `${hostname()}:${process.pid}`,
        pollMs: env.REFUND_POLL_MS,
        log: logger,
      })
    : null

// §13.4: a paid order whose redirect and webhook were both lost is still found.
const sweeper =
  target && flutterwave
    ? createPaymentSweeper({
        store: createPaymentStore(),
        flutterwave,
        testMode: target === 'ote',
        everyMs: env.PAYMENT_SWEEP_MINUTES * 60_000,
        log: logger,
      })
    : null

// I5 / L16: tell a person. Without a Telegram bot the alerts are logged.
const monitor = target
  ? createAlertMonitor({
      store: createAlertStore(),
      notifier:
        env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
          ? createTelegramNotifier({
              token: env.TELEGRAM_BOT_TOKEN,
              chatId: env.TELEGRAM_CHAT_ID,
              log: logger,
            })
          : null,
      testMode: target === 'ote',
      everyMs: env.ALERT_EVERY_MINUTES * 60_000,
      log: logger,
      heartbeatName: `gateway:${target}`,
      readBalanceUsd: async () => {
        const response = await supplierSlots.run(
          () => getDnaWriteClient(target).GetCurrentBalance('USD'),
          { waitMs: 30_000 },
        )
        const balance = Number(response.Balance)
        return response.OperationResult === 'SUCCESS' && Number.isFinite(balance) ? balance : null
      },
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
refunder?.start()
sweeper?.start()
monitor?.start()
if (target && !(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID)) {
  logger.warn({ target }, 'no Telegram bot configured: alerts are only logged')
}

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  await Promise.all([
    worker?.stop(),
    reconciler?.stop(),
    refunder?.stop(),
    sweeper?.stop(),
    monitor?.stop(),
  ])
  server.close()
  process.exit(0)
}
process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))

export { app }
