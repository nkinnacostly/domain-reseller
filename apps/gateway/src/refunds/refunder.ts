import { ORDER_TX_REF_PREFIX } from '@dr/shared'
import {
  chargeTookMoney,
  type Flutterwave,
  type FlutterwaveCharge,
  type FlutterwaveRefund,
  MIN_REFUND_KOBO,
  refundState,
} from '../payments/flutterwave'
import type { Lookup } from '../provisioning/registrar'
import type { ClaimedRefund, RefundStore } from './store'

/**
 * Sends refunds back to the charge they came from (PRD FR-R3, I6, §8.5;
 * backlog L15). The database decides what is owed and refuses anything that
 * would refund more than a charge took; this decides whether it is safe to
 * send now, and records what Flutterwave says.
 *
 * Before any money moves, a refund must pass every check below, in order:
 *   1. at least Flutterwave's ₦100 minimum;
 *   2. the charge, read back from Flutterwave, is one of our orders' — its
 *      reference, currency and amount match what we recorded. The account is
 *      shared with other apps: a wrong row (or a stolen service key) must not
 *      be able to point a refund at someone else's charge;
 *   3. for a failed registration, the registry confirms the domain is not
 *      ours after all — refunding a registered domain pays twice;
 *   4. no chargeback on the charge — Flutterwave warns a refund on a disputed
 *      charge can pay the customer twice;
 *   5. Flutterwave's own list of refunds on the charge matches ours, and
 *      leaves room for this one — the v3 refund call has no idempotency key,
 *      so this read is how a repeat is caught;
 *   6. our Flutterwave balance covers it.
 * Anything it cannot settle goes to a person rather than being guessed (I2):
 * money is never sent twice because a request timed out.
 */

type Log = {
  info(fields: object, message: string): void
  warn(fields: object, message: string): void
  error(fields: object, message: string): void
}

export type RefunderOptions = {
  store: RefundStore
  flutterwave: Flutterwave
  /** Reads the registry through our reseller account. */
  lookup: (domainName: string) => Promise<Lookup>
  /** Test payments are refunded with the test key, real ones with the live key — never both. */
  testMode: boolean
  workerId: string
  pollMs: number
  log: Log
  leaseSeconds?: number
  /** Claims before a refund that cannot be settled goes to a person. */
  maxAttempts?: number
  now?: () => Date
}

const RETRY_SECONDS = [300, 900, 1800, 3600]

export function retryDelay(attempt: number): number {
  return RETRY_SECONDS[Math.min(Math.max(attempt, 1), RETRY_SECONDS.length) - 1] ?? 3600
}

/** How long before asking again about a refund Flutterwave has accepted. */
export function pollDelay(submittedAt: string | null, now: Date): number {
  const ageSeconds = submittedAt ? (now.getTime() - Date.parse(submittedAt)) / 1000 : 0
  if (ageSeconds < 3600) return 600
  if (ageSeconds < 86_400) return 3600
  return 6 * 3600
}

const DAY_MS = 86_400_000

export function createRefunder(options: RefunderOptions) {
  const {
    store,
    flutterwave,
    lookup,
    testMode,
    workerId,
    pollMs,
    log,
    leaseSeconds = 300,
    maxAttempts = 6,
    now = () => new Date(),
  } = options

  const fields = (refund: ClaimedRefund, extra: object = {}) => ({
    refundId: refund.id,
    order: refund.orderNumber,
    reason: refund.reason,
    attempt: refund.attempts,
    ...extra,
  })

  /** A safety check could not be made. Nothing was sent: try later, then a person. */
  async function notSent(refund: ClaimedRefund, code: string, message: string, delay?: number) {
    if (refund.attempts >= maxAttempts) {
      await store.fail(refund.id, workerId, code, message, true)
      log.error(fields(refund, { code }), 'refund needs attention: checks kept failing')
      return
    }
    await store.reschedule(
      refund.id,
      workerId,
      delay ?? retryDelay(refund.attempts),
      code,
      message,
      false,
    )
    log.warn(fields(refund, { code }), 'refund not sent yet')
  }

  /** Stops the refund for a person. Nothing more is sent until they decide. */
  async function stop(refund: ClaimedRefund, code: string, message: string) {
    await store.fail(refund.id, workerId, code, message, true)
    log.error(fields(refund, { code }), 'refund needs attention')
  }

  /** Records a refund of ours that Flutterwave holds. */
  async function record(refund: ClaimedRefund, found: FlutterwaveRefund) {
    const state = refundState(found)
    if (state === 'done') {
      await store.complete(refund.id, workerId, found.id, found.status)
      log.info(fields(refund, { status: found.status }), 'refund completed')
      return
    }
    if (state === 'failed') {
      await store.fail(
        refund.id,
        workerId,
        'PROVIDER_REFUND_FAILED',
        `Flutterwave reports the refund as ${found.status}${found.disburseStatus ? ` (${found.disburseStatus})` : ''}`,
        false,
      )
      log.error(fields(refund, { status: found.status }), 'refund failed at Flutterwave')
      return
    }
    await store.submitted(refund.id, workerId, found.id, found.status, pollDelay(null, now()))
    log.info(fields(refund, { status: found.status }), 'refund accepted by Flutterwave')
  }

  function listFor(refund: ClaimedRefund) {
    const chargedAt = new Date(refund.chargedAt)
    return flutterwave.listRefunds(
      refund.transactionId,
      new Date(chargedAt.getTime() - DAY_MS),
      new Date(now().getTime() + DAY_MS),
    )
  }

  /** Refunds on the charge that no row of ours accounts for. Failed ones returned nothing. */
  function unaccounted(refund: ClaimedRefund, refunds: FlutterwaveRefund[]) {
    return refunds.filter(
      (candidate) =>
        !refund.knownProviderRefundIds.includes(candidate.id) &&
        candidate.id !== refund.providerRefundId &&
        refundState(candidate) !== 'failed',
    )
  }

  /**
   * After a call whose answer was lost: one unaccounted refund, of exactly
   * our amount, that names our charge, is the one we sent. Anything less
   * certain goes to a person — adopting someone else's refund would mark ours
   * done with no money sent.
   */
  function adoptable(refund: ClaimedRefund, extra: FlutterwaveRefund[]) {
    const [only] = extra
    return extra.length === 1 &&
      only &&
      only.amountKobo === refund.amountKobo &&
      only.transactionId === refund.transactionId
      ? only
      : null
  }

  /** Why the charge Flutterwave holds is not the one we recorded, or null when it is. */
  function chargeMismatch(refund: ClaimedRefund, charge: FlutterwaveCharge): string | null {
    if (!refund.orderTxRef.startsWith(ORDER_TX_REF_PREFIX)) return 'the order is not ours'
    if (charge.id !== refund.transactionId) return 'another transaction'
    if (charge.txRef !== refund.orderTxRef) return 'another reference'
    if (charge.currency !== 'NGN') return 'another currency'
    if (charge.amountKobo !== refund.chargedKobo) return 'another amount'
    if (!chargeTookMoney(charge.status)) return `a ${charge.status} charge`
    return null
  }

  async function send(refund: ClaimedRefund) {
    if (refund.providerRefundId) {
      // A refund Flutterwave has already seen is read back, never sent again.
      return stop(refund, 'ALREADY_AT_PROVIDER', 'Queued to send, but already has a reference')
    }
    if (refund.amountKobo < MIN_REFUND_KOBO) {
      return stop(
        refund,
        'BELOW_PROVIDER_MINIMUM',
        'Flutterwave refunds ₦100 or more: refund by hand',
      )
    }
    if (refund.amountKobo + refund.otherRefundsKobo > refund.chargedKobo) {
      return stop(refund, 'EXCEEDS_CHARGE', 'Our refunds on this charge would exceed it')
    }

    const verified = await flutterwave.verifyTransaction(refund.transactionId)
    if (verified.kind === 'unknown') {
      return notSent(refund, verified.code, `Could not read the charge: ${verified.message}`)
    }
    if (verified.kind === 'rejected') {
      return stop(refund, 'CHARGE_NOT_FOUND', 'Flutterwave has no such charge for this key')
    }
    const mismatch = chargeMismatch(refund, verified.data)
    if (mismatch) {
      return stop(refund, 'CHARGE_NOT_OURS', `The charge at Flutterwave is ${mismatch}`)
    }

    if (refund.reason === 'registration_failed') {
      if (!refund.domainName) return stop(refund, 'NO_DOMAIN', 'Refund for a line with no domain')
      const registry = await lookup(refund.domainName)
      // Found while another account here holds the name: the record is theirs.
      if (registry.kind === 'found' && !refund.heldByOtherAccount) {
        return stop(
          refund,
          'REGISTERED_AT_REGISTRY',
          'The registry holds this domain in our account: refunding would pay twice',
        )
      }
      if (registry.kind !== 'found' && registry.kind !== 'not_found') {
        return notSent(
          refund,
          'REGISTRY_UNREADABLE',
          'Could not confirm the domain is unregistered',
        )
      }
    }

    // Disputes are filed by Flutterwave's own reference: take it from the
    // charge Flutterwave just returned, not from our copy.
    const flwRef = verified.data.flwRef ?? refund.flwRef
    if (!flwRef) {
      return stop(
        refund,
        'NO_PROVIDER_REFERENCE',
        'The charge has no reference to check for disputes',
      )
    }
    const disputes = await flutterwave.chargebackCount(flwRef)
    if (disputes.kind !== 'ok') {
      return notSent(refund, disputes.code, `Chargeback check failed: ${disputes.message}`)
    }
    if (disputes.data > 0) {
      return stop(
        refund,
        'CHARGEBACK_ON_CHARGE',
        'The charge is disputed: refunding as well could pay the customer twice',
      )
    }

    const existing = await listFor(refund)
    if (existing.kind !== 'ok') {
      return notSent(refund, existing.code, `Could not read refunds: ${existing.message}`)
    }
    if (!existing.data.complete) {
      return stop(refund, 'TOO_MANY_PROVIDER_REFUNDS', 'More refunds on this charge than one page')
    }
    // Nothing of ours has reached Flutterwave for this refund (it was never
    // called, or its failed attempts are known), so a refund we cannot account
    // for is not ours to adopt: it may be a person's, or another row's.
    if (unaccounted(refund, existing.data.refunds).length > 0) {
      return stop(
        refund,
        'UNTRACKED_REFUND_AT_PROVIDER',
        'Flutterwave holds refunds on this charge that we do not account for',
      )
    }
    const refundedThere = existing.data.refunds
      .filter((candidate) => refundState(candidate) !== 'failed')
      .reduce((sum, candidate) => sum + candidate.amountKobo, 0)
    if (refundedThere + refund.amountKobo > refund.chargedKobo) {
      return stop(refund, 'EXCEEDS_CHARGE_AT_PROVIDER', 'Flutterwave has already refunded too much')
    }

    const balance = await flutterwave.availableBalanceKobo()
    if (balance.kind === 'ok' && balance.data < refund.amountKobo) {
      return notSent(
        refund,
        'INSUFFICIENT_BALANCE',
        'Our Flutterwave balance cannot cover it',
        1800,
      )
    }

    // Omitting the amount refunds the whole charge exactly, kobo and all.
    const whole =
      refund.amountKobo === refund.chargedKobo &&
      refund.otherRefundsKobo === 0 &&
      refundedThere === 0
    await store.noteProviderCall(refund.id, workerId)
    const created = await flutterwave.createRefund(
      refund.transactionId,
      whole ? null : refund.amountKobo,
    )

    if (created.kind === 'ok') {
      if (created.data.amountKobo !== refund.amountKobo) {
        // The money moved, but not the amount we asked for: keep the
        // reference with the stop, in one statement, and let a person square it.
        await store.fail(
          refund.id,
          workerId,
          'AMOUNT_MISMATCH',
          `Flutterwave refunded ${created.data.amountKobo} kobo, not ${refund.amountKobo}`,
          true,
          created.data.id,
        )
        log.error(fields(refund), 'refund amount differs at Flutterwave')
        return
      }
      return record(refund, created.data)
    }
    if (created.kind === 'rejected') {
      await store.fail(refund.id, workerId, created.code, created.message, false)
      log.error(fields(refund, { code: created.code }), 'Flutterwave refused the refund')
      return
    }
    // No answer: it may have landed. Stay in flight; the next claim reads first (I2).
    await store.reschedule(refund.id, workerId, 300, created.code, created.message, true)
    log.warn(fields(refund, { code: created.code }), 'refund outcome unknown; will read back')
  }

  async function recover(refund: ClaimedRefund) {
    if (!refund.providerCalledAt) {
      // The last attempt stopped before it called Flutterwave: nothing was sent.
      await store.reschedule(
        refund.id,
        workerId,
        0,
        'RESUMED',
        'An earlier attempt stopped before sending',
        false,
      )
      log.info(fields(refund), 'refund resumed')
      return
    }

    const existing = await listFor(refund)
    const unreadable = existing.kind !== 'ok' || !existing.data.complete
    const extra = existing.kind === 'ok' ? unaccounted(refund, existing.data.refunds) : []
    const ours = unreadable ? null : adoptable(refund, extra)
    if (ours) return record(refund, ours)

    if (!unreadable && extra.length > 0) {
      return stop(
        refund,
        'UNTRACKED_REFUND_AT_PROVIDER',
        'Flutterwave holds refunds on this charge that we do not account for',
      )
    }
    // Unreadable, or not listed yet. Read again later; after that, a person.
    if (refund.attempts >= maxAttempts) {
      return stop(
        refund,
        'REFUND_OUTCOME_UNKNOWN',
        'Sent without an answer and not found at Flutterwave: check the dashboard before retrying',
      )
    }
    const code = existing.kind === 'ok' ? 'NOT_LISTED_YET' : existing.code
    await store.reschedule(
      refund.id,
      workerId,
      retryDelay(refund.attempts),
      code,
      'Reading back',
      true,
    )
    log.warn(fields(refund, { code }), 'refund outcome still unknown')
  }

  async function poll(refund: ClaimedRefund) {
    if (!refund.providerRefundId) {
      return stop(refund, 'NO_PROVIDER_REFUND_ID', 'Submitted with no Flutterwave reference')
    }
    const found = await flutterwave.getRefund(refund.providerRefundId)
    const delay = pollDelay(refund.submittedAt, now())
    if (found.kind !== 'ok') {
      await store.reschedule(refund.id, workerId, delay, found.code, found.message, true)
      return
    }
    const state = refundState(found.data)
    if (state === 'pending') {
      await store.reschedule(
        refund.id,
        workerId,
        delay,
        'AWAITING_PROVIDER',
        `Flutterwave status ${found.data.status}`,
        true,
      )
      return
    }
    await record(refund, found.data)
  }

  async function run(refund: ClaimedRefund) {
    if (refund.testMode !== testMode) {
      // claim_refund filters by side; this is the belt to its braces (N12).
      throw new Error('Refund claimed for the other side')
    }
    if (refund.action === 'send') await send(refund)
    else if (refund.action === 'recover') await recover(refund)
    else await poll(refund)
  }

  /** Claims and handles one refund. False when there was nothing to do. */
  async function tick(): Promise<boolean> {
    const refund = await store.claim(workerId, testMode, leaseSeconds)
    if (!refund) return false
    try {
      await run(refund)
    } catch (error) {
      // Left in flight on purpose: the lease lapses, and the next claim
      // decides from whether Flutterwave was called (migration 16).
      log.error({ err: error, refundId: refund.id }, 'refund crashed; will be reclaimed')
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
        log.error({ err: error }, 'could not claim a refund')
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
    /** Finishes the refund in hand, then stops. */
    async stop() {
      running = false
      wake?.()
      await loop
    },
  }
}
