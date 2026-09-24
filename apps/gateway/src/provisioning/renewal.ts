import type { Registrar, RegistryDomain } from './registrar'

/**
 * The renewal job for one paid line (PRD E8, FR-RN1, FR-RN5).
 *
 * Renew has no idempotency key, so whether a renewal happened is read from
 * the registry's expiry date, never assumed from an answer (I2, N3):
 *
 * a. Read the domain. Not in our account: the line fails, and is refunded.
 * b. Once a Renew call has been made for this job, its baseline (the expiry
 *    just before the first call) is known. Expiry at baseline + years: done,
 *    an earlier attempt landed. Moved, but not that far: nobody knows why —
 *    a person looks. Not moved: the earlier call did not land; call again,
 *    as a registration is re-sent once it is known not to exist.
 * c. First attempt: record the baseline before calling Renew, so a crash or a
 *    timeout after the call is still decided by reading.
 * d. Renew, then read the record back.
 *
 * No I/O of its own: the registrar makes the calls and the worker records the
 * outcome, so every path is tested without a network.
 */

const DAY_MS = 86_400_000
/** Registries round and time-shift expiry dates; two days either way is the same date. */
const TOLERANCE_MS = 2 * DAY_MS

export function addYears(iso: string, years: number): Date {
  const date = new Date(iso)
  date.setUTCFullYear(date.getUTCFullYear() + years)
  return date
}

/** Whether the registry's expiry shows `years` added to `baseline`. */
export function renewedSince(baseline: string, current: string, years: number): boolean {
  return new Date(current).getTime() >= addYears(baseline, years).getTime() - TOLERANCE_MS
}

/** Whether the expiry has moved at all since `baseline`. */
function movedSince(baseline: string, current: string): boolean {
  return new Date(current).getTime() > new Date(baseline).getTime() + TOLERANCE_MS
}

export type RenewalTask = {
  domainName: string
  years: number
  /** The expiry before this job's first Renew call; null if none has been made. */
  baseline: string | null
  /** Records the baseline before the first call and returns the one stored. */
  noteBaseline: (expiresAt: string) => Promise<string>
}

export type RenewalOutcome =
  | {
      kind: 'renewed'
      domain: RegistryDomain & { expiresAt: string }
      /** Found already renewed by a read — an earlier attempt landed. */
      recovered: boolean
    }
  /** Refused, or not in our account: this line has failed and is refunded. */
  | { kind: 'rejected'; code: string; message: string }
  /** Known not to have renewed after a failed attempt: safe to try again. */
  | { kind: 'not_renewed'; code: string; message: string }
  /** Nobody knows yet. Read again later; never renew again blind. */
  | { kind: 'unknown'; code: string; message: string }
  | { kind: 'blocked'; code: string; message: string }

type Read =
  | { kind: 'found'; domain: RegistryDomain & { expiresAt: string } }
  | Exclude<RenewalOutcome, { kind: 'renewed' } | { kind: 'not_renewed' }>

async function read(registrar: Registrar, domainName: string): Promise<Read> {
  const looked = await registrar.lookup(domainName)
  if (looked.kind === 'not_found') {
    return {
      kind: 'rejected',
      code: 'DOMAIN_NOT_FOUND',
      message: 'The domain is not in our account at the registry',
    }
  }
  if (looked.kind !== 'found') return looked
  const { expiresAt } = looked.domain
  if (!expiresAt) {
    return { kind: 'unknown', code: 'NO_EXPIRY', message: 'The registry gave no expiry date' }
  }
  return { kind: 'found', domain: { ...looked.domain, expiresAt } }
}

export async function runRenewal(registrar: Registrar, task: RenewalTask): Promise<RenewalOutcome> {
  // a.
  const before = await read(registrar, task.domainName)
  if (before.kind !== 'found') return before

  // b.
  if (task.baseline) {
    if (renewedSince(task.baseline, before.domain.expiresAt, task.years)) {
      return { kind: 'renewed', domain: before.domain, recovered: true }
    }
    if (movedSince(task.baseline, before.domain.expiresAt)) {
      return {
        kind: 'unknown',
        code: 'EXPIRY_MOVED',
        message: 'The expiry moved, but not by the years paid for — check before renewing again',
      }
    }
  }

  // c.
  const baseline = await task.noteBaseline(task.baseline ?? before.domain.expiresAt)

  // d.
  const written = await registrar.renew(task.domainName, task.years)
  if (written.kind === 'rejected' || written.kind === 'blocked') {
    return { kind: written.kind, code: written.code, message: written.message }
  }

  const after = await read(registrar, task.domainName)
  if (after.kind === 'found' && renewedSince(baseline, after.domain.expiresAt, task.years)) {
    return { kind: 'renewed', domain: after.domain, recovered: written.kind !== 'ok' }
  }
  if (written.kind === 'ok') {
    // Accepted, but the record does not show it yet: read again later.
    return {
      kind: 'unknown',
      code: 'NOT_YET_VISIBLE',
      message: 'Renewal accepted but the new expiry is not showing yet',
    }
  }
  if (after.kind === 'found' && !movedSince(baseline, after.domain.expiresAt)) {
    return { kind: 'not_renewed', code: written.code, message: written.message }
  }
  return { kind: 'unknown', code: written.code, message: written.message }
}
