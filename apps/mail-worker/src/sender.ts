import type { TenantSender } from '@dr/shared/ses'
import type { Pacer } from './pacing'
import type { ClaimedEmail, MailStore, SendOutcome, UnreadableClaim } from './store'

/**
 * The send loop (MAIL-SPEC §3, §4.4): the only code that calls SendEmail.
 *
 *   claim   — claim_sends: due emails, FOR UPDATE SKIP LOCKED; SQL asks the
 *             gate again for each (MR2) and settles those that may not go.
 *   pace    — the token bucket at MAIL_MAX_SEND_RATE (MR8), per recipient.
 *   send    — SES SendEmail with the account's tenant and configuration set
 *             (MR1; the shared sender refuses a send without both).
 *   record  — record_send_result: sent with SES's message id; throttled and
 *             retried emails go back to the queue; refused ones fail.
 *   beat    — a heartbeat after every run, so a silent worker is noticed (§11).
 *
 * Throttling and MaxSendRateExceeded are "try again shortly", never a
 * failure, and they pause the bucket: the SES account's rate is shared.
 * Logs carry ids, counts and codes — never an address, a subject or a body
 * (N13, MR4).
 */

type Log = {
  info(fields: object, message: string): void
  warn(fields: object, message: string): void
  error(fields: object, message: string): void
}

export type SenderOptions = {
  store: MailStore
  ses: TenantSender
  pacer: Pacer
  workerId: string
  batchSize: number
  pollMs: number
  log: Log
  /** §4.4: when the SES account's day is nearly spent, only paid accounts send. */
  paidOnly?: () => boolean
  sleep?: (ms: number) => Promise<void>
  clock?: () => number
  /** At most one heartbeat this often while idle; one after every run that sent. */
  heartbeatEveryMs?: number
}

export type SendRun = {
  claimed: number
  sent: number
  failed: number
  retried: number
  throttled: number
}

/** After SES throttles us: this long before anything else is sent. */
export const THROTTLE_PAUSE_MS = 1_000
/** And this long before the throttled email is tried again. */
export const THROTTLE_RETRY_SECONDS = 2

export const HEARTBEAT_NAME = 'mail-worker:send'

function toSesEmail(email: ClaimedEmail) {
  return {
    tenantName: email.tenant,
    configurationSetName: email.configurationSet,
    emailId: email.publicId,
    accountShortId: email.accountShortId,
    from: email.from,
    to: email.to,
    cc: email.cc,
    bcc: email.bcc,
    replyTo: email.replyTo,
    subject: email.subject,
    html: email.html,
    text: email.text,
    headers: email.headers,
    attachments: email.attachments.map((file) => ({
      filename: file.filename,
      contentType: file.content_type,
      content: file.content,
      ...(file.content_id ? { contentId: file.content_id } : {}),
    })),
    tags: email.tags,
  }
}

const isUnreadable = (claim: ClaimedEmail | UnreadableClaim): claim is UnreadableClaim =>
  'unreadable' in claim

export function createSender(options: SenderOptions) {
  const {
    store,
    ses,
    pacer,
    workerId,
    batchSize,
    pollMs,
    log,
    paidOnly = () => false,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    clock = Date.now,
    heartbeatEveryMs = 30_000,
  } = options

  let lastRunAt: number | null = null
  let lastBeatAt: number | null = null

  async function sendOne(email: ClaimedEmail, run: SendRun): Promise<void> {
    const fields = {
      emailId: email.publicId,
      account: email.accountShortId,
      attempt: email.attempt,
    }
    await pacer.take(email.recipientCount)
    const result = await ses.send(toSesEmail(email))
    let outcome: SendOutcome
    if (result.ok) {
      outcome = { outcome: 'sent', messageId: result.messageId }
      run.sent += 1
    } else if (result.kind === 'throttled') {
      pacer.pause(THROTTLE_PAUSE_MS)
      outcome = {
        outcome: 'throttled',
        code: result.code,
        retryAfterSeconds: THROTTLE_RETRY_SECONDS,
      }
      run.throttled += 1
      log.warn({ ...fields, code: result.code }, 'SES throttled a send; it waits and goes again')
    } else if (result.kind === 'retry') {
      outcome = {
        outcome: 'retry',
        code: result.code ?? (result.status === null ? 'no_answer' : null),
      }
      run.retried += 1
      log.warn(
        { ...fields, status: result.status, code: result.code },
        'send not accepted; it will be tried again',
      )
    } else {
      outcome = { outcome: 'failed', code: result.code ?? 'ses_refused' }
      run.failed += 1
      log.warn({ ...fields, status: result.status, code: result.code }, 'SES refused the email')
    }
    const recorded = await store.record(email.id, workerId, outcome)
    if (!recorded) log.error(fields, 'the claim had passed to another worker; result not recorded')
  }

  async function runOnce(): Promise<SendRun> {
    const run: SendRun = { claimed: 0, sent: 0, failed: 0, retried: 0, throttled: 0 }
    const claims = await store.claim(workerId, batchSize, paidOnly())
    run.claimed = claims.length
    for (const claim of claims) {
      if (isUnreadable(claim)) {
        log.error({ id: claim.id }, 'a claimed email could not be read; it fails')
        await store.record(claim.id, workerId, { outcome: 'failed', code: 'unreadable_claim' })
        run.failed += 1
        continue
      }
      try {
        await sendOne(claim, run)
      } catch (error) {
        // The database could not take the result: the claim lapses and the
        // email is sent again later (at-least-once, as the shop's outbox).
        log.error(
          { emailId: claim.publicId, err: error instanceof Error ? error.message : 'error' },
          'a send could not be recorded',
        )
      }
    }
    const at = clock()
    if (run.claimed > 0 || lastBeatAt === null || at - lastBeatAt >= heartbeatEveryMs) {
      await store.heartbeat(HEARTBEAT_NAME, { ...run, paidOnly: paidOnly() })
      lastBeatAt = at
    }
    if (run.claimed > 0) log.info({ ...run }, 'mail sent')
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
        log.error({ err: error instanceof Error ? error.message : 'error' }, 'mail send run failed')
      }
      // A full batch means more is waiting: go again at once; otherwise rest.
      if (running && !full) await sleep(pollMs)
    }
  }

  return {
    runOnce,
    /** When a run last finished — the health check's sign of life. */
    lastRunAt: () => lastRunAt,
    start() {
      if (running) return
      running = true
      current = loop()
    },
    /** Finishes the email in hand, then stops. */
    async stop() {
      running = false
      await current
    },
  }
}

export type Sender = ReturnType<typeof createSender>
