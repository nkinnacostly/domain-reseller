import { isReservedAddress, renderNotice } from '@dr/shared'
import type { Mailer } from './brevo'
import type { EmailStore } from './store'

/**
 * Sends the notification emails the database queues (migration 31, PRD
 * E12): claims what is due on this gateway's side, renders each from its
 * versioned template (@dr/shared) and hands it to Brevo. A second, slower
 * loop reads back whether ERRP and security notices were delivered, so a
 * bounced compliance notice becomes an ops alert (FR-NT3).
 *
 * Never logs an address or a message body (N13) — the email's id and kind.
 */

type Log = {
  info(fields: object, message: string): void
  warn(fields: object, message: string): void
  error(fields: object, message: string): void
}

export type EmailSenderOptions = {
  store: EmailStore
  mailer: Mailer
  testMode: boolean
  workerId: string
  /** Links in emails point here. */
  siteUrl: string
  pollMs: number
  deliveryEveryMs: number
  log: Log
  batchSize?: number
  now?: () => Date
}

export type SendRun = { sent: number; failed: number; skipped: number }

/** A notice still "deferred" this long after sending did not arrive: treat it as bounced. */
const GIVE_UP_AFTER_MS = 3 * 86_400_000

export function createEmailSender(options: EmailSenderOptions) {
  const {
    store,
    mailer,
    testMode,
    workerId,
    siteUrl,
    pollMs,
    deliveryEveryMs,
    log,
    batchSize = 10,
    now = () => new Date(),
  } = options

  async function sendDue(): Promise<SendRun> {
    const run: SendRun = { sent: 0, failed: 0, skipped: 0 }
    const due = await store.claim(workerId, testMode, batchSize)

    for (const email of due) {
      const fields = { emailId: email.id, kind: email.kind }
      if (isReservedAddress(email.toEmail)) {
        await store.skipped(email.id, workerId, 'reserved_address')
        run.skipped += 1
        continue
      }
      const rendered = renderNotice(email.kind, email.data, {
        siteUrl,
        testMode: email.testMode,
        now: now(),
      })
      if (!rendered.ok) {
        // Our own bug (a kind with no template, or data it cannot use):
        // sending again cannot help, and the failure raises an alert.
        log.error({ ...fields, reason: rendered.reason }, 'email cannot be rendered')
        await store.failed(email.id, workerId, rendered.reason, true)
        run.failed += 1
        continue
      }
      const { notice } = rendered
      const result = await mailer.send({
        to: email.toEmail,
        subject: notice.subject,
        html: notice.html,
        text: notice.text,
        tags: notice.tags,
      })
      if (result.ok) {
        await store.sent(email.id, workerId, result.messageId, notice.version)
        run.sent += 1
      } else {
        log.warn({ ...fields, error: result.error, permanent: result.permanent }, 'email not sent')
        await store.failed(email.id, workerId, result.error, result.permanent)
        run.failed += 1
      }
    }
    if (due.length > 0) log.info(run, 'emails sent')
    return run
  }

  async function checkDeliveries(): Promise<number> {
    const due = await store.deliveryDue(50)
    let checked = 0
    for (const email of due) {
      try {
        let status = await mailer.delivery(email.messageId)
        if (status === 'deferred' && now().getTime() - email.sentAt.getTime() > GIVE_UP_AFTER_MS) {
          status = 'bounced'
        }
        await store.recordDelivery(email.id, status)
        if (status === 'bounced') log.warn({ emailId: email.id }, 'notice bounced')
        checked += 1
      } catch (error) {
        log.warn(
          { emailId: email.id, err: error instanceof Error ? error.message : String(error) },
          'delivery not checked',
        )
      }
    }
    return checked
  }

  function loop(name: string, everyMs: number, task: () => Promise<unknown>) {
    let timer: NodeJS.Timeout | null = null
    let current: Promise<void> | null = null
    let running = false
    async function cycle() {
      try {
        await task()
      } catch (error) {
        log.error({ err: error instanceof Error ? error.message : String(error) }, `${name} failed`)
      }
      if (running) timer = setTimeout(tick, everyMs)
    }
    function tick() {
      current = cycle()
    }
    return {
      start() {
        if (running) return
        running = true
        tick()
      },
      async stop() {
        running = false
        if (timer) clearTimeout(timer)
        await current
      },
    }
  }

  const sending = loop('email sending', pollMs, sendDue)
  const delivery = loop('email delivery check', deliveryEveryMs, checkDeliveries)

  return {
    sendDue,
    checkDeliveries,
    start() {
      sending.start()
      delivery.start()
    },
    async stop() {
      await Promise.all([sending.stop(), delivery.stop()])
    },
  }
}
