import type { Contact } from '@dr/shared'
import type { Registrar, RegistryDomain } from './registrar'

/**
 * The provision job for one paid line (PRD §13.4, box "PROVISION JOB").
 *
 * a. Pre-flight read: already ours? Then it is done (I1) — this is what makes
 *    a crashed or timed-out attempt safe to run again.
 * b. Register, then read the full record back.
 * c. No clear answer: read again, never re-send (I2).
 * d. A refusal: this line fails, classified, no retry.
 * e. Registered: apply the checkout's nameservers. A delegation problem never
 *    fails the registration (FR-R5).
 *
 * No I/O of its own: the registrar does the calls and the worker records the
 * outcome, so every path here is tested without a network.
 */

export type RegistrationTask = {
  domainName: string
  periodYears: number
  privacy: boolean
  contact: Contact
  nameservers: string[] | null
}

export type NameserverOutcome =
  | { result: 'applied'; nameservers: string[] }
  | { result: 'rejected'; code: string; message: string }
  | { result: 'unknown'; code: string; message: string }
  | { result: 'blocked'; code: string; message: string }

export type RegistrationOutcome =
  | {
      kind: 'registered'
      domain: RegistryDomain
      /** Found already registered by a read — an earlier attempt landed. */
      recovered: boolean
      nameservers: NameserverOutcome | { result: 'none' }
    }
  /** Refused by the registry: this line has failed. */
  | { kind: 'rejected'; code: string; message: string }
  /** Known not to be registered after a failed attempt: safe to try again. */
  | { kind: 'not_registered'; code: string; message: string }
  /** Nobody knows yet. Read again later; never write again blind. */
  | { kind: 'unknown'; code: string; message: string }
  | { kind: 'blocked'; code: string; message: string }

export function sameNameservers(a: string[], b: string[]): boolean {
  const normalise = (list: string[]) =>
    [...new Set(list.map((host) => host.trim().toLowerCase().replace(/\.$/, '')))].sort()
  const left = normalise(a)
  const right = normalise(b)
  return left.length === right.length && left.every((host, index) => host === right[index])
}

/** FR-N1 / FR-R5. A timeout is settled by reading what the registry now has. */
export async function applyNameservers(
  registrar: Registrar,
  domainName: string,
  nameservers: string[],
): Promise<NameserverOutcome> {
  const written = await registrar.setNameservers(domainName, nameservers)
  if (written.kind === 'ok') return { result: 'applied', nameservers: written.data }
  if (written.kind === 'rejected') {
    return { result: 'rejected', code: written.code, message: written.message }
  }

  const check = await registrar.lookup(domainName)
  if (check.kind === 'found' && sameNameservers(check.domain.nameservers, nameservers)) {
    return { result: 'applied', nameservers: check.domain.nameservers }
  }
  return written.kind === 'blocked'
    ? { result: 'blocked', code: written.code, message: written.message }
    : { result: 'unknown', code: written.code, message: written.message }
}

export async function runRegistration(
  registrar: Registrar,
  task: RegistrationTask,
): Promise<RegistrationOutcome> {
  // a. I1: a registration is never attempted without looking first.
  const before = await registrar.lookup(task.domainName)
  if (before.kind === 'unknown' || before.kind === 'blocked') {
    return { kind: before.kind, code: before.code, message: before.message }
  }

  let domain: RegistryDomain
  let recovered = false
  if (before.kind === 'found') {
    domain = before.domain
    recovered = true
  } else {
    // b.
    const written = await registrar.register({
      domainName: task.domainName,
      periodYears: task.periodYears,
      contact: task.contact,
      privacy: task.privacy,
    })
    if (written.kind === 'rejected') {
      return { kind: 'rejected', code: written.code, message: written.message }
    }
    if (written.kind === 'blocked') {
      return { kind: 'blocked', code: written.code, message: written.message }
    }
    if (written.kind === 'ok') {
      // The register answer leaves out the lock, the nameservers and the start
      // date (seen in the sandbox, 23 Sept 2026): read the full record, and
      // fall back to the answer only if the read fails.
      const record = await registrar.lookup(task.domainName)
      domain = record.kind === 'found' ? record.domain : written.data
    } else {
      // c. I2: the write may have landed. Ask; never send it again from here.
      const after = await registrar.lookup(task.domainName)
      if (after.kind === 'found') {
        domain = after.domain
        recovered = true
      } else if (after.kind === 'not_found') {
        return { kind: 'not_registered', code: written.code, message: written.message }
      } else {
        return { kind: 'unknown', code: written.code, message: written.message }
      }
    }
  }

  // e. FR-R5: nameservers after, and never at the registration's expense.
  if (!task.nameservers?.length) {
    return { kind: 'registered', domain, recovered, nameservers: { result: 'none' } }
  }
  if (sameNameservers(domain.nameservers, task.nameservers)) {
    return {
      kind: 'registered',
      domain,
      recovered,
      nameservers: { result: 'applied', nameservers: domain.nameservers },
    }
  }
  const nameservers = await applyNameservers(registrar, task.domainName, task.nameservers)
  return {
    kind: 'registered',
    domain:
      nameservers.result === 'applied'
        ? { ...domain, nameservers: nameservers.nameservers }
        : domain,
    recovered,
    nameservers,
  }
}
