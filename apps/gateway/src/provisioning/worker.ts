import { contactSchema } from '@dr/shared'
import type { PaymentCheck } from '../payments/charge-check'
import type { Registrar, TransferRegistrar } from './registrar'
import { runRenewal } from './renewal'
import { applyNameservers, runRegistration } from './saga'
import type { ClaimedJob, JobStore } from './store'
import { runTransfer } from './transfer'

/**
 * Works the provisioning queue (PRD §13.6): claim one due job, run it, record
 * the outcome, repeat; sleep when there is nothing to do. One job at a time —
 * the supplier allows two calls in flight and searches need the other.
 *
 * A crash anywhere leaves the job `running`; its lease lapses and it is
 * claimed again, starting with a registry read (I1). So nothing here needs to
 * be careful about dying half way.
 */

type Log = {
  info(fields: object, message: string): void
  warn(fields: object, message: string): void
  error(fields: object, message: string): void
}

export type WorkerOptions = {
  store: JobStore
  /** A registrar whose calls are recorded against this job (I7). */
  registrarFor: (job: ClaimedJob) => Registrar
  /** The same, for transfers in (PRD E9). Without it a transfer job is held for a person. */
  transfersFor?: (job: ClaimedJob) => TransferRegistrar
  /** Confirms with Flutterwave that the charge behind a registration is real (SEC-7). */
  checkPayment: (job: ClaimedJob) => Promise<PaymentCheck>
  /** Test payments go to the sandbox, real ones to the live registry — never both. */
  testMode: boolean
  workerId: string
  pollMs: number
  log: Log
  leaseSeconds?: number
  /** Claims per job, the first included (PRD §13.4 c: three retries). */
  maxAttempts?: number
  /** Seconds before the next claim, by the attempt just made. */
  backoffSeconds?: (attempt: number) => number
  now?: () => Date
}

const BACKOFF_SECONDS = [30, 120, 600, 1800]

export function defaultBackoff(attempt: number): number {
  return BACKOFF_SECONDS[Math.min(Math.max(attempt, 1), BACKOFF_SECONDS.length) - 1] ?? 1800
}

const DAY_MS = 86_400_000
/** PRD §13.5: a pending transfer is polled every 15 minutes… */
export const TRANSFER_POLL_SECONDS = 900
/** …and hourly once it has waited a day — most finish in hours, or wait out the five days. */
export const TRANSFER_SLOW_POLL_SECONDS = 3600
/**
 * The losing registrar has five days to answer, after which the registry
 * completes the transfer (ICANN Transfer Policy). Double that with nothing
 * decided, and a person looks.
 */
export const TRANSFER_DEADLINE_DAYS = 10

export function transferPollSeconds(submittedAt: string | null | undefined, now: Date): number {
  const age = now.getTime() - Date.parse(submittedAt ?? '')
  return age >= DAY_MS ? TRANSFER_SLOW_POLL_SECONDS : TRANSFER_POLL_SECONDS
}

export function createWorker(options: WorkerOptions) {
  const {
    store,
    registrarFor,
    transfersFor,
    checkPayment,
    testMode,
    workerId,
    pollMs,
    log,
    leaseSeconds = 300,
    maxAttempts = 4,
    backoffSeconds = defaultBackoff,
    now = () => new Date(),
  } = options

  /** Unknown or blocked: try again later, until retries run out — then a person looks (I2). */
  async function unsettled(job: ClaimedJob, code: string, message: string) {
    if (job.attempts < maxAttempts) {
      await store.reschedule(job.id, backoffSeconds(job.attempts), code, message)
      log.warn({ jobId: job.id, kind: job.kind, attempt: job.attempts, code }, 'job rescheduled')
      return
    }
    await store.fail(job.id, code, message, true)
    log.error({ jobId: job.id, kind: job.kind, code }, 'job needs attention: outcome unknown')
  }

  /**
   * Nothing is registered or renewed — not even read from the registry — for
   * a charge Flutterwave does not confirm. A refusal goes to a person, never
   * to a refund: refunding a charge that is not real would pay out twice.
   */
  async function paidFor(job: ClaimedJob): Promise<boolean> {
    const paid = await checkPayment(job)
    if (paid.kind === 'verified') return true
    if (paid.kind === 'unknown') {
      await unsettled(job, paid.code, paid.message)
      return false
    }
    await store.fail(job.id, paid.code, paid.message, true)
    log.error({ jobId: job.id, kind: job.kind, code: paid.code }, 'stopped: payment not verified')
    return false
  }

  async function register(job: ClaimedJob, registrar: Registrar) {
    if (!(await paidFor(job))) return

    const contact = contactSchema.safeParse(job.registrant)
    if (!contact.success || !job.periodYears) {
      // Our data, not the registry's answer: fix it and retry, don't refund.
      await store.fail(job.id, 'BAD_JOB', 'Registrant or period missing or invalid', true)
      log.error({ jobId: job.id }, 'registration job has invalid data')
      return
    }

    const outcome = await runRegistration(registrar, {
      domainName: job.domainName,
      periodYears: job.periodYears,
      privacy: job.privacy,
      contact: contact.data,
      nameservers: job.pendingNameservers,
    })

    switch (outcome.kind) {
      case 'registered': {
        const ns = outcome.nameservers
        await store.completeRegistration(job.id, {
          domain: outcome.domain,
          recovered: outcome.recovered,
          // Blocked is an operations problem: keep the request and queue it again.
          nameserverResult: ns.result === 'blocked' ? 'unknown' : ns.result,
          nameserverCode: 'code' in ns ? ns.code : null,
        })
        log.info(
          { jobId: job.id, domainId: job.domainId, recovered: outcome.recovered, ns: ns.result },
          'domain registered',
        )
        return
      }
      case 'rejected':
        await store.fail(job.id, outcome.code, outcome.message, false)
        log.warn({ jobId: job.id, code: outcome.code }, 'registration refused')
        return
      case 'not_registered':
        if (job.attempts < maxAttempts) {
          await store.reschedule(
            job.id,
            backoffSeconds(job.attempts),
            outcome.code,
            outcome.message,
          )
          log.warn({ jobId: job.id, attempt: job.attempts }, 'registration not made; retrying')
        } else {
          // Known not registered, retries spent: the line fails and is refunded.
          await store.fail(job.id, 'SUPPLIER_UNAVAILABLE', outcome.message, false)
          log.error({ jobId: job.id }, 'registration failed after retries')
        }
        return
      case 'unknown':
      case 'blocked':
        if (outcome.kind === 'blocked') {
          log.error({ jobId: job.id, code: outcome.code }, 'supplier refused our credentials')
        }
        await unsettled(job, outcome.code, outcome.message)
        return
    }
  }

  async function renew(job: ClaimedJob, registrar: Registrar) {
    if (!(await paidFor(job))) return
    if (!job.periodYears) {
      await store.fail(job.id, 'BAD_JOB', 'Renewal period missing', true)
      log.error({ jobId: job.id }, 'renewal job has invalid data')
      return
    }

    const outcome = await runRenewal(registrar, {
      domainName: job.domainName,
      years: job.periodYears,
      baseline: job.baselineExpiry,
      noteBaseline: (expiresAt) => store.noteRenewalBaseline(job.id, expiresAt),
    })

    switch (outcome.kind) {
      case 'renewed':
        await store.completeRenewal(job.id, outcome.domain.expiresAt, outcome.recovered)
        log.info(
          { jobId: job.id, domainId: job.domainId, recovered: outcome.recovered },
          'domain renewed',
        )
        return
      case 'rejected':
        await store.fail(job.id, outcome.code, outcome.message, false)
        log.warn({ jobId: job.id, code: outcome.code }, 'renewal refused')
        return
      case 'not_renewed':
        if (job.attempts < maxAttempts) {
          await store.reschedule(
            job.id,
            backoffSeconds(job.attempts),
            outcome.code,
            outcome.message,
          )
          log.warn({ jobId: job.id, attempt: job.attempts }, 'renewal not made; retrying')
        } else {
          // Known not renewed, retries spent: the line fails and is refunded.
          await store.fail(job.id, 'SUPPLIER_UNAVAILABLE', outcome.message, false)
          log.error({ jobId: job.id }, 'renewal failed after retries')
        }
        return
      case 'unknown':
      case 'blocked':
        if (outcome.kind === 'blocked') {
          log.error({ jobId: job.id, code: outcome.code }, 'supplier refused our credentials')
        }
        await unsettled(job, outcome.code, outcome.message)
        return
    }
  }

  /**
   * A transfer the registry has: polled on its own clock, never by the
   * attempts cap — a transfer that takes five days is not failing (FR-T3).
   * Past the deadline with nothing decided, a person looks; never a refund.
   */
  async function keepPolling(job: ClaimedJob, code: string, message: string) {
    const at = now()
    const waited = at.getTime() - Date.parse(job.submittedAt ?? '')
    if (waited >= TRANSFER_DEADLINE_DAYS * DAY_MS) {
      await store.fail(
        job.id,
        'TRANSFER_OVERDUE',
        `Not complete ${TRANSFER_DEADLINE_DAYS} days after the request (${code})`,
        true,
      )
      log.error({ jobId: job.id, code }, 'transfer needs attention: overdue')
      return
    }
    await store.reschedule(job.id, transferPollSeconds(job.submittedAt, at), code, message)
  }

  async function transferIn(job: ClaimedJob) {
    if (!transfersFor) {
      await store.fail(job.id, 'TRANSFERS_OFF', 'This gateway does not work transfers', true)
      log.error({ jobId: job.id }, 'transfer job held: no transfer registrar')
      return
    }
    const submitted = Boolean(job.submittedAt)
    // Once the registry has the request the money is spent: the charge is
    // confirmed before, and polling asks Flutterwave nothing.
    if (!submitted && !(await paidFor(job))) return

    const contact = contactSchema.safeParse(job.registrant)
    if (!submitted && (!contact.success || !job.periodYears)) {
      await store.fail(job.id, 'BAD_JOB', 'Registrant or period missing or invalid', true)
      log.error({ jobId: job.id }, 'transfer job has invalid data')
      return
    }

    const outcome = await runTransfer(transfersFor(job), {
      domainName: job.domainName,
      authCode: job.authCode ?? null,
      periodYears: job.periodYears ?? 1,
      // Only the request uses it; polling needs none.
      contact: contact.success ? contact.data : null,
      submittedAt: job.submittedAt ?? null,
      now: now(),
    })

    switch (outcome.kind) {
      case 'transferred': {
        const recorded = await store.completeTransfer(job.id, outcome.domain, outcome.recovered)
        if (recorded === 'held_elsewhere') {
          await store.fail(job.id, 'ALREADY_HERE', 'Another account here holds this name', false)
          log.error({ jobId: job.id }, 'transfer found done, but the name is held here already')
          return
        }
        log.info(
          { jobId: job.id, domainId: job.domainId, recovered: outcome.recovered },
          'domain transferred in',
        )
        return
      }
      case 'submitted':
        await store.markTransferSubmitted(job.id, TRANSFER_POLL_SECONDS)
        log.info({ jobId: job.id, domainId: job.domainId }, 'transfer submitted')
        return
      case 'waiting':
        return keepPolling(job, 'TRANSFER_PENDING', 'Waiting on the current registrar')
      case 'rejected':
        await store.fail(job.id, outcome.code, outcome.message, false)
        log.warn({ jobId: job.id, code: outcome.code }, 'transfer refused')
        return
      case 'not_submitted':
        if (job.attempts < maxAttempts) {
          await store.reschedule(
            job.id,
            backoffSeconds(job.attempts),
            outcome.code,
            outcome.message,
          )
          log.warn({ jobId: job.id, attempt: job.attempts }, 'transfer not sent; retrying')
        } else {
          // Known not sent, retries spent: the line fails and is refunded.
          await store.fail(job.id, 'SUPPLIER_UNAVAILABLE', outcome.message, false)
          log.error({ jobId: job.id }, 'transfer failed after retries')
        }
        return
      case 'unknown':
      case 'blocked':
        if (outcome.kind === 'blocked') {
          log.error({ jobId: job.id, code: outcome.code }, 'supplier refused our credentials')
        }
        if (submitted) return keepPolling(job, outcome.code, outcome.message)
        await unsettled(job, outcome.code, outcome.message)
        return
    }
  }

  async function changeNameservers(job: ClaimedJob, registrar: Registrar) {
    const requested = job.pendingNameservers
    if (!requested || job.localStatus !== 'active') {
      await store.fail(
        job.id,
        'NOT_APPLICABLE',
        'Nothing to apply, or the domain is not active',
        false,
      )
      return
    }
    const outcome = await applyNameservers(registrar, job.domainName, requested)
    if (outcome.result === 'applied') {
      await store.recordNameserverChange(job.id, requested, outcome.nameservers, null)
      log.info({ jobId: job.id, domainId: job.domainId }, 'nameservers applied')
    } else if (outcome.result === 'rejected') {
      await store.recordNameserverChange(job.id, requested, null, outcome.code)
      log.warn({ jobId: job.id, code: outcome.code }, 'nameservers refused')
    } else {
      await unsettled(job, outcome.code, outcome.message)
    }
  }

  async function run(job: ClaimedJob) {
    if (job.kind === 'transfer_domain') return transferIn(job)
    const registrar = registrarFor(job)
    switch (job.kind) {
      case 'register_domain':
        return register(job, registrar)
      case 'renew_domain':
        return renew(job, registrar)
      case 'apply_nameservers':
        return changeNameservers(job, registrar)
      default:
        // A kind this build does not know: hold it for a person — never fail
        // it as something else, which could refund a line that is fine.
        await store.fail(job.id, 'UNKNOWN_JOB_KIND', `No handler for ${String(job.kind)}`, true)
        log.error({ jobId: job.id, kind: job.kind }, 'job of an unknown kind held')
    }
  }

  /** Claims and runs one job. False when the queue had nothing due. */
  async function tick(): Promise<boolean> {
    const job = await store.claim(workerId, testMode, leaseSeconds)
    if (!job) return false
    try {
      await run(job)
    } catch (error) {
      // Left running on purpose: the lease lapses and a pre-flight read decides.
      log.error({ err: error, jobId: job.id }, 'job crashed; will be reclaimed after its lease')
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
        log.error({ err: error }, 'could not claim a job')
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
    /** Finishes the job in hand, then stops. */
    async stop() {
      running = false
      wake?.()
      await loop
    },
  }
}
