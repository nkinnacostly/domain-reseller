import type { Contact } from '@dr/shared'
import {
  asRegistryContact,
  type ContactRole,
  type RegistryContacts,
  type SettingsRegistrar,
  type SettingWrite,
  sameContact,
} from './registrar'

/**
 * A registry-side setting (FR-DS1, FR-DS3, FR-DS4): the transfer lock,
 * privacy, or the contacts. None of these writes has an idempotency key or a
 * trustworthy answer, so the registry is read before and after (I1, I2):
 *
 * a. Read. Already holds what was asked for: done, nothing is written.
 * b. Write.
 * c. Read back, whatever the write said. Holds the new value: applied. The
 *    write was accepted and the record says otherwise: nobody knows yet —
 *    read again later, and a person looks if it stays that way.
 * d. The write had no clear answer (N3): the read decides. The old value
 *    means it did not land, so it is safe to try again later; anything else
 *    is unknown.
 * e. A refusal is recorded as one, with its code.
 *
 * No I/O of its own: the registrar makes the calls and the worker records
 * the outcome, so every path is tested without a network.
 */

export type SettingTask =
  | { kind: 'set_transfer_lock'; domainName: string; requested: boolean }
  | { kind: 'set_privacy'; domainName: string; requested: boolean }
  | { kind: 'update_contacts'; domainName: string; requested: Contact }

export type SettingOutcome =
  | {
      kind: 'applied'
      /** Found applied by a read — nothing written, or an unclear write that landed. */
      recovered: boolean
    }
  /** Refused by the registry: recorded as refused, with this code. */
  | { kind: 'rejected'; code: string; message: string }
  /** Known not applied after an unclear attempt: safe to try again. */
  | { kind: 'not_applied'; code: string; message: string }
  /** Nobody knows yet. Read again later; never write again blind. */
  | { kind: 'unknown'; code: string; message: string }
  | { kind: 'blocked'; code: string; message: string }

type Held<T> =
  | { kind: 'found'; value: T }
  | Exclude<SettingOutcome, { kind: 'applied' } | { kind: 'not_applied' }>

/** One setting as a read, a comparison and a write. */
type Setting<T> = {
  read(): Promise<Held<T>>
  same(held: T, other: T): boolean
  requested: T
  write(): Promise<SettingWrite>
}

const NOT_OURS = {
  kind: 'rejected',
  code: 'DOMAIN_NOT_FOUND',
  message: 'The domain is not in our account at the registry',
} as const

function flag(
  registrar: SettingsRegistrar,
  domainName: string,
  field: 'transferLock' | 'privacy',
): () => Promise<Held<boolean>> {
  return async () => {
    const looked = await registrar.lookup(domainName)
    if (looked.kind === 'found') return { kind: 'found', value: looked.domain[field] }
    return looked.kind === 'not_found' ? NOT_OURS : looked
  }
}

/**
 * The roles the registry shows, each against the same role in `other`. A
 * role missing from either side is not compared; the registrant always is.
 */
export function sameContacts(shown: RegistryContacts, other: RegistryContacts): boolean {
  if (!shown.registrant || !other.registrant) return false
  return (Object.keys(shown) as ContactRole[]).every((role) => {
    const mine = shown[role]
    const theirs = other[role]
    return !mine || !theirs || sameContact(mine, theirs)
  })
}

async function run<T>(change: Setting<T>): Promise<SettingOutcome> {
  // a. I1: never written without looking first.
  const before = await change.read()
  if (before.kind !== 'found') return before
  if (change.same(before.value, change.requested)) return { kind: 'applied', recovered: true }

  // b.
  const written = await change.write()
  if (written.kind === 'rejected' || written.kind === 'blocked') {
    return { kind: written.kind, code: written.code, message: written.message }
  }

  // c. What the registry holds decides, never the write's answer.
  const after = await change.read()
  if (after.kind === 'found' && change.same(after.value, change.requested)) {
    return { kind: 'applied', recovered: written.kind !== 'ok' }
  }
  if (written.kind === 'ok') {
    return {
      kind: 'unknown',
      code: 'NOT_YET_VISIBLE',
      message: 'The registry accepted the change but does not show it yet',
    }
  }

  // d. N3: an unclear write is settled by reading, never by sending it again now.
  if (after.kind === 'found' && change.same(after.value, before.value)) {
    return { kind: 'not_applied', code: written.code, message: written.message }
  }
  return { kind: 'unknown', code: written.code, message: written.message }
}

const sameFlag = (a: boolean, b: boolean) => a === b

export function runSettingChange(
  registrar: SettingsRegistrar,
  task: SettingTask,
): Promise<SettingOutcome> {
  switch (task.kind) {
    case 'set_transfer_lock':
      return run({
        read: flag(registrar, task.domainName, 'transferLock'),
        same: sameFlag,
        requested: task.requested,
        write: () => registrar.setTransferLock(task.domainName, task.requested),
      })
    case 'set_privacy':
      return run({
        read: flag(registrar, task.domainName, 'privacy'),
        same: sameFlag,
        requested: task.requested,
        write: () => registrar.setPrivacy(task.domainName, task.requested),
      })
    case 'update_contacts': {
      // Checkout's one person holds every role (registrar.ts contactSet).
      const wanted = asRegistryContact(task.requested)
      return run<RegistryContacts>({
        read: async () => {
          const read = await registrar.contacts(task.domainName)
          if (read.kind === 'found') return { kind: 'found', value: read.data }
          return read.kind === 'not_found' ? NOT_OURS : read
        },
        same: sameContacts,
        requested: {
          registrant: wanted,
          administrative: wanted,
          technical: wanted,
          billing: wanted,
        },
        write: () => registrar.updateContacts(task.domainName, task.requested),
      })
    }
  }
}
