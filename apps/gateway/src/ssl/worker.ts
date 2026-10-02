import { sslContactSchema } from '@dr/shared'
import type { PaymentCheck } from '../payments/charge-check'
import { defaultBackoff } from '../provisioning/worker'
import type { SslClient } from './client'
import { runSslConfigure, runSslInitialize, runSslReissue } from './jobs'
import { toSupplierContact } from './status'
import type { ClaimedSslJob, SslStore } from './store'

/**
 * Works the SSL queue (migration 39) as the provisioning worker works
 * registrations (PRD §13.6): claim one due job, run it, record the outcome,
 * repeat. A crash leaves the job running; its lease lapses and the next
 * claim starts with a read.
 *
 * - ssl_initialize — buys the certificate (FR-SSL-3), only for a charge
 *   Flutterwave confirms (SEC-7). Refused: the line fails and is refunded.
 *   Unknown: read, never re-send (N3); retries spent → a person.
 * - ssl_configure — the customer's set-up (FR-SSL-4). Refused: back to them.
 * - ssl_reissue — a new certificate for the same names (FR-SSL-8).
 * - anything else — held for a person, never guessed at.
 */

type Log = {
  info(fields: object, message: string): void
  warn(fields: object, message: string): void
  error(fields: object, message: string): void
}

export type SslWorkerOptions = {
  store: SslStore
  /** A client whose calls are recorded against this job (I7). */
  clientFor: (job: ClaimedSslJob) => SslClient
  checkPayment: (job: ClaimedSslJob) => Promise<PaymentCheck>
  testMode: boolean
  workerId: string
  pollMs: number
  log: Log
  leaseSeconds?: number
  /** Claims per job, the first included. */
  maxAttempts?: number
  backoffSeconds?: (attempt: number) => number
}

const SETUP_WEB_SERVERS = new Set(['apache', 'iis'])

export function createSslWorker(options: SslWorkerOptions) {
  const {
    store,
    clientFor,
    checkPayment,
    testMode,
    workerId,
    pollMs,
    log,
    leaseSeconds = 300,
    maxAttempts = 4,
    backoffSeconds = defaultBackoff,
  } = options

  /** Unknown or blocked: later, until retries run out — then a person (I2). */
  async function unsettled(job: ClaimedSslJob, code: string, message: string) {
    if (job.attempts < maxAttempts) {
      await store.reschedule(job.id, backoffSeconds(job.attempts), code, message)
      log.warn(
        { jobId: job.id, kind: job.kind, attempt: job.attempts, code },
        'SSL job rescheduled',
      )
      return
    }
    await store.fail(job.id, code, message, true)
    log.error({ jobId: job.id, kind: job.kind, code }, 'SSL job needs attention: outcome unknown')
  }

  async function hold(job: ClaimedSslJob, code: string, message: string) {
    await store.fail(job.id, code, message, true)
    log.error({ jobId: job.id, kind: job.kind, code }, 'SSL job held for a person')
  }

  /** Nothing is bought for a charge Flutterwave does not confirm; a refusal is a person's, never a refund. */
  async function paidFor(job: ClaimedSslJob): Promise<boolean> {
    // Once a purchase may have been sent, the money is spent: only reads follow.
    if (job.sentAt) return true
    const paid = await checkPayment(job)
    if (paid.kind === 'verified') return true
    if (paid.kind === 'unknown') {
      await unsettled(job, paid.code, paid.message)
      return false
    }
    await hold(job, paid.code, paid.message)
    return false
  }

  async function order(job: ClaimedSslJob, client: SslClient) {
    if (!(await paidFor(job))) return
    const outcome = await runSslInitialize(client, {
      name: job.commonName,
      productCode: job.productCode,
      isWildcard: job.isWildcard,
      nameTaken: job.nameTaken,
      sentAt: job.sentAt,
      noteSent: () => store.noteSent(job.id),
    })
    switch (outcome.kind) {
      case 'bought': {
        const recorded = await store.completeInitialize(
          job.id,
          outcome.certificate,
          outcome.recovered,
        )
        if (recorded === 'name_held_here') {
          await hold(job, 'NAME_HELD_HERE', 'Bought, but another certificate here holds the name')
          return
        }
        log.info(
          { jobId: job.id, certificateId: job.certificateId, recovered: outcome.recovered },
          'SSL certificate ordered',
        )
        return
      }
      case 'refused':
        // Nothing was bought for this line: it fails and is refunded.
        await store.fail(job.id, outcome.code, outcome.message, false)
        log.warn({ jobId: job.id, code: outcome.code }, 'SSL order refused')
        return
      case 'held':
        return hold(job, outcome.code, outcome.message)
      case 'unknown':
      case 'blocked':
        if (outcome.kind === 'blocked') {
          log.error({ jobId: job.id, code: outcome.code }, 'supplier refused our credentials')
        }
        return unsettled(job, outcome.code, outcome.message)
    }
  }

  async function setUp(job: ClaimedSslJob, client: SslClient) {
    const contact = sslContactSchema.safeParse(job.contact)
    if (
      !job.csr ||
      !job.approverEmail ||
      !job.webServer ||
      !SETUP_WEB_SERVERS.has(job.webServer) ||
      !contact.success
    ) {
      // Our data, not the supplier's answer: a person fixes it.
      return hold(job, 'BAD_JOB', 'The set-up is missing or invalid')
    }
    const outcome = await runSslConfigure(client, {
      name: job.commonName,
      csr: job.csr,
      approverEmail: job.approverEmail,
      webServer: job.webServer as 'apache' | 'iis',
      extraNames: job.sanNames,
      contact: toSupplierContact(contact.data),
      sentAt: job.sentAt,
      noteSent: () => store.noteSent(job.id),
    })
    switch (outcome.kind) {
      case 'configured':
        await store.recordConfigured(job.id, outcome.supplierStatus, outcome.recovered)
        log.info({ jobId: job.id, certificateId: job.certificateId }, 'SSL certificate set up')
        return
      case 'refused':
        await store.refuseSetup(job.id, outcome.code, outcome.message)
        log.warn({ jobId: job.id, code: outcome.code }, 'SSL set-up refused')
        return
      case 'held':
        return hold(job, outcome.code, outcome.message)
      case 'unknown':
      case 'blocked':
        return unsettled(job, outcome.code, outcome.message)
    }
  }

  async function reissue(job: ClaimedSslJob, client: SslClient) {
    const outcome = await runSslReissue(client, {
      name: job.commonName,
      approverEmail: job.approverEmail,
      sentAt: job.sentAt,
      noteSent: () => store.noteSent(job.id),
    })
    switch (outcome.kind) {
      case 'reissued':
        await store.recordReissue(job.id, outcome.supplierStatus, outcome.state, outcome.recovered)
        log.info(
          { jobId: job.id, certificateId: job.certificateId, state: outcome.state },
          'SSL certificate reissued',
        )
        return
      case 'refused':
        // Back to the issued certificate, with our code; nothing was bought.
        await store.fail(job.id, outcome.code, outcome.message, false)
        log.warn({ jobId: job.id, code: outcome.code }, 'SSL reissue refused')
        return
      case 'unknown':
      case 'blocked':
        return unsettled(job, outcome.code, outcome.message)
    }
  }

  async function run(job: ClaimedSslJob) {
    const client = clientFor(job)
    switch (job.kind) {
      case 'ssl_initialize':
        return order(job, client)
      case 'ssl_configure':
        return setUp(job, client)
      case 'ssl_reissue':
        return reissue(job, client)
      default:
        // A kind this build does not know: a person looks. Never run it as
        // something else, which could buy or refund what it should not.
        return hold(job, 'UNKNOWN_JOB_KIND', `No handler for ${job.kind}`)
    }
  }

  /** Claims and runs one job. False when nothing was due. */
  async function tick(): Promise<boolean> {
    const job = await store.claim(workerId, testMode, leaseSeconds)
    if (!job) return false
    try {
      await run(job)
    } catch (error) {
      // Left running on purpose: the lease lapses and the next claim reads first.
      log.error({ err: error, jobId: job.id }, 'SSL job crashed; reclaimed after its lease')
    }
    return true
  }

  let running = false
  let loop: Promise<void> | null = null
  let wake: (() => void) | null = null

  function pause(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      wake = () => {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  async function work() {
    while (running) {
      let busy = false
      try {
        busy = await tick()
      } catch (error) {
        log.error({ err: error }, 'could not claim an SSL job')
      }
      if (!busy && running) await pause(pollMs)
    }
  }

  return {
    tick,
    start() {
      if (running) return
      running = true
      loop = work()
    },
    async stop() {
      running = false
      wake?.()
      await loop
    },
  }
}
