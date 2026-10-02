import type { ConfigureInput, SslClient, SslDetails, SslStatusAnswer } from './client'
import { isConfiguredWord, type SslState, sslState } from './status'

/**
 * The three SSL jobs (FR-SSL-3, FR-SSL-4, FR-SSL-8), as sagas over the
 * supplier client. No I/O of their own: the worker records each outcome.
 *
 * The rule (N3, I2): read first; note the send before it goes; after an
 * unknown answer, read — and never send the same write again once a send
 * has been noted. An `initialize` sent twice is a certificate bought twice,
 * so for it "not visible yet" stays unknown until a person looks.
 */

type Unsettled =
  | { kind: 'unknown'; code: string; message: string }
  | { kind: 'blocked'; code: string; message: string }

const unknown = (code: string, message: string) => ({ kind: 'unknown' as const, code, message })

// ── Ordering ─────────────────────────────────────────────────────────────────

export type InitializeTask = {
  name: string
  productCode: string
  isWildcard: boolean
  /** Another certificate for this name is ours already (claim_ssl_job's name_taken). */
  nameTaken: boolean
  /** When a previous attempt noted it was sending; null if none ever did. */
  sentAt: string | null
  /** Notes the send (note_ssl_job_sent) and returns when. A throw means do not send. */
  noteSent: () => Promise<string>
}

export type Bought = {
  certificateId: string | null
  supplierStatus: string
  purchasedAt: string | null
  subscriptionEndsAt: string | null
}

export type InitializeOutcome =
  | { kind: 'bought'; recovered: boolean; certificate: Bought }
  /** Nothing was bought for this line: the line fails and is refunded. */
  | { kind: 'refused'; code: string; message: string }
  /** Our own records disagree with the supplier: a person looks, nothing is refunded. */
  | { kind: 'held'; code: string; message: string }
  | Unsettled

async function readBack(
  client: SslClient,
  task: InitializeTask,
  fallback: { certificateId: string | null; status: string },
): Promise<Bought> {
  // GET /ssls/certificate refuses a `*.` name: a wildcard has only check-status.
  if (!task.isWildcard) {
    const details = await client.details(task.name)
    if (details.kind === 'found') {
      return {
        certificateId: fallback.certificateId,
        supplierStatus: details.data.status,
        purchasedAt: details.data.purchasedAt,
        subscriptionEndsAt: details.data.subscriptionEndsAt,
      }
    }
  }
  return {
    certificateId: fallback.certificateId,
    supplierStatus: fallback.status || 'WaitingForInstall',
    purchasedAt: null,
    subscriptionEndsAt: null,
  }
}

/** A certificate found under the name after we sent: ours, if it is the product we bought. */
async function adopt(
  client: SslClient,
  task: InitializeTask,
  found: SslStatusAnswer,
): Promise<InitializeOutcome> {
  if (!task.isWildcard) {
    const details = await client.details(task.name)
    if (
      details.kind === 'found' &&
      details.data.packageCode &&
      details.data.packageCode !== task.productCode
    ) {
      return {
        kind: 'held',
        code: 'NAME_HAS_OTHER_CERTIFICATE',
        message: `The supplier holds a ${details.data.packageCode} certificate for this name, not ${task.productCode}`,
      }
    }
  }
  return {
    kind: 'bought',
    recovered: true,
    certificate: await readBack(client, task, { certificateId: null, status: found.status }),
  }
}

export async function runSslInitialize(
  client: SslClient,
  task: InitializeTask,
): Promise<InitializeOutcome> {
  if (task.nameTaken) {
    return task.sentAt
      ? {
          kind: 'held',
          code: 'NAME_TAKEN_AFTER_SEND',
          message: 'Another certificate here holds this name, and this one was sent',
        }
      : {
          kind: 'refused',
          code: 'NAME_HAS_CERTIFICATE',
          message: 'Another certificate here already holds this name',
        }
  }

  // Read first: what does the supplier hold under this name?
  const before = await client.status(task.name)
  if (before.kind === 'unknown' || before.kind === 'blocked') return before
  if (before.kind === 'found') {
    if (task.sentAt) return adopt(client, task, before.data)
    // Never sent by this job, yet there: the supplier reaches only the first
    // certificate on a name, so a second could never be set up. Nothing was
    // bought for this line.
    return {
      kind: 'refused',
      code: 'NAME_HAS_CERTIFICATE',
      message: 'The supplier already holds a certificate under this name',
    }
  }
  if (task.sentAt) {
    // Sent before, not there yet: read again later — never buy again (N3).
    return unknown('NOT_YET_VISIBLE', 'An earlier order was sent and is not visible yet')
  }

  await task.noteSent()
  const written = await client.initialize(task.productCode, task.name)
  if (written.kind === 'ok') {
    return {
      kind: 'bought',
      recovered: false,
      certificate: await readBack(client, task, written.data),
    }
  }
  if (written.kind === 'rejected') {
    return { kind: 'refused', code: written.code, message: written.message }
  }
  // Unknown or blocked: it may have landed. Read; never send again.
  const after = await client.status(task.name)
  if (after.kind === 'found') return adopt(client, task, after.data)
  return written
}

// ── Setting up ───────────────────────────────────────────────────────────────

export type ConfigureTask = ConfigureInput & {
  sentAt: string | null
  noteSent: () => Promise<string>
}

export type ConfigureOutcome =
  | { kind: 'configured'; recovered: boolean; supplierStatus: string }
  /** Something the customer can fix: back to them with our code. */
  | { kind: 'refused'; code: string; message: string }
  | { kind: 'held'; code: string; message: string }
  | Unsettled

export async function runSslConfigure(
  client: SslClient,
  task: ConfigureTask,
): Promise<ConfigureOutcome> {
  const before = await client.status(task.name)
  if (before.kind === 'unknown' || before.kind === 'blocked') return before
  if (before.kind === 'not_found') {
    return unknown('CERTIFICATE_NOT_FOUND', 'The supplier does not list the certificate we bought')
  }
  if (before.data.isConfigured || isConfiguredWord(before.data.status)) {
    if (task.sentAt) {
      return { kind: 'configured', recovered: true, supplierStatus: before.data.status }
    }
    return {
      kind: 'held',
      code: 'ALREADY_CONFIGURED',
      message: 'The supplier shows a set-up this job never sent',
    }
  }

  // Not configured: safe to send — configuring buys nothing, and the read
  // above shows no earlier send landed.
  await task.noteSent()
  const written = await client.configure(task)
  if (written.kind === 'ok') {
    return {
      kind: 'configured',
      recovered: false,
      supplierStatus: written.data.status || 'WaitingForValidation',
    }
  }
  if (written.kind === 'rejected') {
    return { kind: 'refused', code: written.code, message: written.message }
  }
  const after = await client.status(task.name)
  if (after.kind === 'found' && (after.data.isConfigured || isConfiguredWord(after.data.status))) {
    return { kind: 'configured', recovered: true, supplierStatus: after.data.status }
  }
  return written
}

// ── Reissuing ────────────────────────────────────────────────────────────────

export type ReissueTask = {
  name: string
  approverEmail: string | null
  sentAt: string | null
  noteSent: () => Promise<string>
}

export type ReissueOutcome =
  | { kind: 'reissued'; recovered: boolean; supplierStatus: string; state: ReissueState }
  | { kind: 'refused'; code: string; message: string }
  | Unsettled

type ReissueState = Extract<SslState, 'awaiting_setup' | 'awaiting_validation' | 'issued'>

/** Where a certificate stands after a reissue, by the supplier's word. */
function reissueState(status: SslStatusAnswer | SslDetails): ReissueState | null {
  const state = sslState(status.status)
  return state === 'awaiting_setup' || state === 'awaiting_validation' || state === 'issued'
    ? state
    : null
}

export async function runSslReissue(client: SslClient, task: ReissueTask): Promise<ReissueOutcome> {
  const before = await client.status(task.name)
  if (before.kind === 'unknown' || before.kind === 'blocked') return before
  if (before.kind === 'not_found') {
    return unknown('CERTIFICATE_NOT_FOUND', 'The supplier does not list the certificate')
  }

  if (task.sentAt) {
    // Sent before: a certificate no longer simply "Active" took it. Never send again.
    const state = reissueState(before.data)
    if (state && state !== 'issued') {
      return { kind: 'reissued', recovered: true, supplierStatus: before.data.status, state }
    }
    return unknown('REISSUE_UNCONFIRMED', 'A reissue was sent and the supplier shows no change')
  }
  if (sslState(before.data.status) !== 'issued') {
    return {
      kind: 'refused',
      code: 'SSL_WRONG_STATE',
      message: `The supplier shows "${before.data.status}", not an issued certificate`,
    }
  }

  await task.noteSent()
  const written = await client.reissue(task.name, task.approverEmail)
  if (written.kind === 'rejected') {
    return { kind: 'refused', code: written.code, message: written.message }
  }
  const after = await client.status(task.name)
  if (after.kind === 'found') {
    const state = reissueState(after.data)
    if (written.kind === 'ok' && state) {
      return { kind: 'reissued', recovered: false, supplierStatus: after.data.status, state }
    }
    if (state && state !== 'issued') {
      return { kind: 'reissued', recovered: true, supplierStatus: after.data.status, state }
    }
  }
  if (written.kind === 'ok') {
    return unknown('REISSUE_UNREADABLE', 'The reissue was taken; its state could not be read')
  }
  return written
}
