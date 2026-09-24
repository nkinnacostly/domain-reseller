import type { Contact } from '@dr/shared'
import { type RegistryDomain, type TransferRegistrar, transferState } from './registrar'

/**
 * The transfer-in job for one paid line (PRD E9, FR-T2, FR-T3).
 *
 * Transfer has no idempotency key, and a transfer takes days, so the job has
 * two halves, told apart by `submittedAt` (migration 26):
 *
 * Before the registry has the request:
 * a. Read the domain (I1). Already ours and active: an earlier attempt landed —
 *    done. Waiting for us: an earlier attempt was taken — submitted.
 * b. No transfer code: nothing can be sent; the line fails and is refunded.
 * c. CheckTransfer with the code. Not transferable: the line fails, refunded.
 * d. Transfer. Taken: submitted. Refused: the line fails, refunded. No answer:
 *    read (I2, N3) — waiting or landed means it was taken; nothing there means
 *    it was not, and it is safe to send on a later attempt.
 *
 * After, poll by reading: active in our account is done; still waiting is
 * waiting; cancelled, refused or gone for a day is refused.
 *
 * No I/O of its own: the registrar makes the calls and the worker records the
 * outcome, so every path is tested without a network.
 */

const HOUR_MS = 3_600_000
/**
 * A request the registry took shows up in our account within moments. Until a
 * day has passed, a read that finds nothing is lag, not a refusal.
 */
export const NOT_LISTED_GRACE_MS = 24 * HOUR_MS

export type TransferTask = {
  domainName: string
  /** Held only until the registry has the request; null after, or if it was lost. */
  authCode: string | null
  periodYears: number
  /** Sent with the request. The worker holds a job without a valid one for a person. */
  contact: Contact | null
  /** When the registry took the request; null before. */
  submittedAt: string | null
  now: Date
}

export type TransferOutcome =
  | {
      kind: 'transferred'
      domain: RegistryDomain & { expiresAt: string }
      /** Found already done by the first read — an earlier attempt landed. */
      recovered: boolean
    }
  /** The registry has the request: the code can go, and the job polls. */
  | { kind: 'submitted' }
  /** Polling: still with the current registrar. */
  | { kind: 'waiting' }
  /** Refused or cancelled: this line has failed and is refunded. */
  | { kind: 'rejected'; code: string; message: string }
  /** Known not to have been sent after a failed attempt: safe to send again. */
  | { kind: 'not_submitted'; code: string; message: string }
  /** Nobody knows yet. Read again later; never send again blind. */
  | { kind: 'unknown'; code: string; message: string }
  | { kind: 'blocked'; code: string; message: string }

type Read =
  | { kind: 'landed'; domain: RegistryDomain & { expiresAt: string } }
  | { kind: 'waiting' }
  /** Not in our account, or gone from it. */
  | { kind: 'absent'; listed: boolean }
  | { kind: 'unknown'; code: string; message: string }
  | { kind: 'blocked'; code: string; message: string }

async function read(registrar: TransferRegistrar, domainName: string): Promise<Read> {
  const looked = await registrar.lookup(domainName)
  if (looked.kind === 'not_found') return { kind: 'absent', listed: false }
  if (looked.kind !== 'found') return looked
  const state = transferState(looked.domain.status)
  if (state === 'waiting') return { kind: 'waiting' }
  if (state === 'gone') return { kind: 'absent', listed: true }
  if (state === 'unclear') {
    return {
      kind: 'unknown',
      code: 'REGISTRY_STATUS_UNCLEAR',
      message: `The registry lists it as "${looked.domain.status ?? ''}"`,
    }
  }
  const { expiresAt } = looked.domain
  if (!expiresAt) {
    return { kind: 'unknown', code: 'NO_EXPIRY', message: 'The registry gave no expiry date' }
  }
  return { kind: 'landed', domain: { ...looked.domain, expiresAt } }
}

/** After submission: where the request stands now. */
async function poll(registrar: TransferRegistrar, task: TransferTask): Promise<TransferOutcome> {
  const now = await read(registrar, task.domainName)
  if (now.kind === 'landed') return { kind: 'transferred', domain: now.domain, recovered: false }
  if (now.kind !== 'absent') return now
  const age = task.now.getTime() - Date.parse(task.submittedAt ?? '')
  if (!now.listed && !(age >= NOT_LISTED_GRACE_MS)) return { kind: 'waiting' }
  return {
    kind: 'rejected',
    code: 'TRANSFER_REJECTED',
    message: now.listed
      ? 'The registry shows the transfer cancelled or refused'
      : 'The transfer is no longer in our account',
  }
}

export async function runTransfer(
  registrar: TransferRegistrar,
  task: TransferTask,
): Promise<TransferOutcome> {
  if (task.submittedAt) return poll(registrar, task)

  // a.
  const before = await read(registrar, task.domainName)
  if (before.kind === 'landed') {
    return { kind: 'transferred', domain: before.domain, recovered: true }
  }
  if (before.kind === 'waiting') return { kind: 'submitted' }
  if (before.kind !== 'absent') return before

  // b.
  if (!task.authCode) {
    return {
      kind: 'rejected',
      code: 'AUTH_CODE_MISSING',
      message: 'No transfer code is held for this line',
    }
  }
  if (!task.contact) {
    return { kind: 'unknown', code: 'BAD_JOB', message: 'No valid registrant to send' }
  }

  // c. FR-T1: the supplier's word before the write.
  const check = await registrar.checkTransfer(task.domainName, task.authCode)
  if (check.kind !== 'ok') return check
  if (!check.data.transferable) {
    return {
      kind: 'rejected',
      code: check.data.reason,
      message: 'The supplier says the domain cannot be transferred now',
    }
  }

  // d.
  const written = await registrar.transfer({
    domainName: task.domainName,
    authCode: task.authCode,
    periodYears: task.periodYears,
    contact: task.contact,
  })
  if (written.kind === 'ok') return { kind: 'submitted' }
  if (written.kind === 'rejected' || written.kind === 'blocked') {
    return { kind: written.kind, code: written.code, message: written.message }
  }

  // I2: it may have been taken. Ask; never send it again from here.
  const after = await read(registrar, task.domainName)
  if (after.kind === 'waiting' || after.kind === 'landed') return { kind: 'submitted' }
  if (after.kind === 'absent') {
    return { kind: 'not_submitted', code: written.code, message: written.message }
  }
  return { kind: 'unknown', code: written.code, message: written.message }
}
