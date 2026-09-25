import { isReservedAddress, renderNotice } from '@dr/shared'
import type { Mailer } from './mailer'
import type { EmailStore } from './store'

/**
 * Sends the notification emails the database queues (migration 31, PRD
 * E12): claims what is due on this gateway's side, renders each from its
 * versioned template (@dr/shared) and hands it to the provider — Brevo or
 * SES (EMAIL_PROVIDER). Sends are spaced at least `minIntervalMs` apart, so
 * SES's per-second rate (1 in its sandbox) is never exceeded.
 *
 * A second, slower loop reads back from Brevo whether ERRP and security
 * notices were delivered, so a bounced compliance notice becomes an ops
 * alert (FR-NT3). SES cannot be asked: it pushes those reports to the web
 * (migration 34), so with SES that loop does not run.
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
  /** The least time between two sends (SES's maximum send rate); 0 sends back to back. */
  minIntervalMs?: number
  now?: () => Date
  /** Test seams for the pacing: a millisecond clock and a wait. */
  clock?: () => number
  sleep?: (ms: number) => Promise<void>
}

export type SendRun = { sent: number; failed: number; skipped: number }

/** A notice still "deferred" this long after sending did not arrive: treat it as bounced. */
const GIVE_UP_AFTER_MS = 3 * 86_400_000

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

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
    minIntervalMs = 0,
    now = () => new Date(),
    clock = Date.now,
    sleep = wait,
  } = options

  let lastSendAt: number | null = null

  /**
   * Holds a send back until the provider's rate allows it — across runs too.
   * Measured from the last answer, not the last start: a slow answer must not
   * let two sends reach SES closer together than its rate.
   */
  async function paced<T>(send: () => Promise<T>): Promise<T> {
    if (lastSendAt !== null && minIntervalMs > 0) {
      const due = lastSendAt + minIntervalMs - clock()
      if (due > 0) await sleep(due)
    }
    try {
      return await send()
    } finally {
      lastSendAt = clock()
    }
  }

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
      const result = await paced(() =>
        mailer.send({
          to: email.toEmail,
          subject: notice.subject,
          html: notice.html,
          text: notice.text,
          tags: notice.tags,
        }),
      )
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
    const read = mailer.delivery
    // SES reports by push (migration 34); nothing to ask.
    if (!read) return 0
    const due = await store.deliveryDue(50)
    let checked = 0
    for (const email of due) {
      try {
        let status = await read(email.messageId)
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
  const delivery = mailer.delivery
    ? loop('email delivery check', deliveryEveryMs, checkDeliveries)
    : null

  return {
    sendDue,
    checkDeliveries,
    /** Whether this sender polls the provider for delivery reports (Brevo) or not (SES). */
    readsDeliveries: delivery !== null,
    start() {
      sending.start()
      delivery?.start()
    },
    async stop() {
      await Promise.all([sending.stop(), delivery?.stop()])
    },
  }
}
