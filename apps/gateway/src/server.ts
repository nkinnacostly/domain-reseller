import { hostname } from 'node:os'
import { serve } from '@hono/node-server'
import { createAlertMonitor } from './alerts/monitor'
import { createAlertStore } from './alerts/store'
import { createTelegramNotifier } from './alerts/telegram'
import { createApp } from './app'
import { catalogueScheduleFor } from './catalogue/schedule'
import { delegationCheckerFor } from './delegation/checker'
import { getDnaWriteClient } from './dna/client'
import { emailSetupFor } from './email/provider'
import { createEmailSender } from './email/sender'
import { createEmailStore } from './email/store'
import { env } from './env'
import { logger } from './lib/logger'
import { supplierSlots } from './lib/semaphore'
import { checkPayment } from './payments/charge-check'
import { createFlutterwave } from './payments/flutterwave'
import { createPaymentStore } from './payments/store'
import { createPaymentSweeper } from './payments/sweeper'
import { presetCheckerFor } from './presets/checker'
import { createDnaRegistrar } from './provisioning/registrar'
import { createSupabaseStore } from './provisioning/store'
import { createWorker } from './provisioning/worker'
import { createDeepSync, createDeepSyncReader } from './reconcile/deep-sync'
import { createDeepSyncStore } from './reconcile/deep-sync-store'
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
        // FR-DS1, FR-DS3, FR-DS4: registry-side settings, on the same side.
        settingsFor: (job) =>
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

// §13.5 deep sync: each domain on that side read on its own with GetDetails,
// daily and soon after a change, and corrected as the reconcile would.
// Read-only at the supplier, one domain at a time in its low lane.
const deepSync =
  target && store
    ? createDeepSync({
        store: createDeepSyncStore(),
        reader: createDeepSyncReader({
          client: getDnaWriteClient(target),
          environment: target,
          audit: (call) => store.recordCall(null, target, call),
        }),
        testMode: target === 'ote',
        everyMs: env.DEEP_SYNC_EVERY_MINUTES * 60_000,
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

// PRD E12: the notification emails the database queues, for this side,
// through EMAIL_PROVIDER (Brevo by default, or SES) once its credentials are set.
const email = target ? emailSetupFor(env, logger) : null
const emailSender =
  target && email?.mailer
    ? createEmailSender({
        store: createEmailStore(),
        mailer: email.mailer,
        minIntervalMs: email.minIntervalMs,
        testMode: target === 'ote',
        workerId: `${hostname()}:${process.pid}`,
        siteUrl: env.APP_URL ?? 'https://www.mydomainshub.com',
        pollMs: env.EMAIL_POLL_MS,
        deliveryEveryMs: env.EMAIL_DELIVERY_CHECK_MINUTES * 60_000,
        log: logger,
      })
    : null

// N5b: the weekly supplier catalogue sync — here, so it keeps working once the supplier allowlists this address.
const catalogueSync = catalogueScheduleFor(env, logger)
// FR-D5: live domains' delegation, checked against public resolvers.
const delegationCheck = delegationCheckerFor(env, logger)
// FR-D2: host presets whose nameservers stop resolving are hidden from customers.
const presetCheck = presetCheckerFor(env, logger)

if (worker) {
  worker.start()
  logger.info(
    { target, orders: target === 'ote' ? 'test payments' : 'live payments' },
    'provisioning worker started',
  )
}
reconciler?.start()
deepSync?.start()
refunder?.start()
sweeper?.start()
monitor?.start()
catalogueSync?.start()
delegationCheck?.start()
presetCheck?.start()
emailSender?.start()
if (emailSender && email) {
  // Which provider, never its keys (N13).
  logger.info(
    {
      target,
      provider: email.provider,
      deliveryReports: emailSender.readsDeliveries ? 'polled' : 'pushed to the web',
    },
    'email sender started',
  )
} else if (target && email && !email.mailer) {
  logger.warn(
    { target, provider: email.provider, missing: email.missing },
    'email provider not configured: notification emails wait in the outbox',
  )
}
if (target && !(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID)) {
  logger.warn({ target }, 'no Telegram bot configured: alerts are only logged')
}

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  await Promise.all([
    worker?.stop(),
    reconciler?.stop(),
    deepSync?.stop(),
    refunder?.stop(),
    sweeper?.stop(),
    monitor?.stop(),
    catalogueSync?.stop(),
    delegationCheck?.stop(),
    presetCheck?.stop(),
    emailSender?.stop(),
  ])
  server.close()
  process.exit(0)
}
process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))

export { app }
