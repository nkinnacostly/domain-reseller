import { contactSchema } from '@dr/shared'
import type { PaymentCheck } from '../payments/charge-check'
import type { Registrar } from './registrar'
import { runRenewal } from './renewal'
import { applyNameservers, runRegistration } from './saga'
import type { ClaimedJob, JobStore } from './store'

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
}

const BACKOFF_SECONDS = [30, 120, 600, 1800]

export function defaultBackoff(attempt: number): number {
  return BACKOFF_SECONDS[Math.min(Math.max(attempt, 1), BACKOFF_SECONDS.length) - 1] ?? 1800
}

export function createWorker(options: WorkerOptions) {
  const {
    store,
    registrarFor,
    checkPayment,
    testMode,
    workerId,
    pollMs,
    log,
    leaseSeconds = 300,
    maxAttempts = 4,
    backoffSeconds = defaultBackoff,
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
