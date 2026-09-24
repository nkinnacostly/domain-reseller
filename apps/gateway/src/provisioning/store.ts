import type { Database, Json } from '@dr/db'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { WriteTarget } from '../dna/client'
import { env } from '../env'
import type { PaymentFacts } from '../payments/charge-check'
import type { CallRecord, RegistryDomain } from './registrar'

/**
 * The job queue, as the worker sees it. Each method is one database function
 * (migrations 13 and 20), so a job, its order line, its domain and its order
 * change in one transaction or not at all.
 */

export type ClaimedJob = {
  id: string
  kind:
    | 'register_domain'
    | 'apply_nameservers'
    | 'renew_domain'
    | 'transfer_domain'
    | 'set_transfer_lock'
    | 'set_privacy'
    | 'update_contacts'
  /** Including this one. */
  attempts: number
  testMode: boolean
  domainId: string
  domainName: string
  localStatus: string
  privacy: boolean
  registrant: unknown
  pendingNameservers: string[] | null
  periodYears: number | null
  /** Our record of the expiry; the registry's is read before anything is renewed. */
  expiresAt: string | null
  /** Renewals: the registry's expiry just before this job's first Renew call (migration 23). */
  baselineExpiry: string | null
  /** For a registration or renewal: the charge that paid for it, confirmed with Flutterwave first. */
  payment: PaymentFacts | null
  /** 'registration', 'transfer' or 'demo' — a demo row never reaches a registry. */
  source?: string | null
  /** Registry-side settings (migration 26): what was asked for, not yet confirmed. Null: none. */
  pendingTransferLock?: boolean | null
  pendingPrivacy?: boolean | null
  pendingRegistrant?: unknown
  /**
   * FR-DS1 (migration 29): the administrative, technical and billing contacts
   * the domain holds, and those asked for. A role left out is the registrant;
   * a pending `{}` puts all three back on the registrant. Null: none stored.
   */
  contacts?: unknown
  pendingContacts?: unknown
  /** A transfer's code, handed over only until the registry has the request (migration 26). */
  authCode?: string | null
  /** A transfer: when the registry took the request. Set, the job polls. */
  submittedAt?: string | null
}

/** What became of recording a transfer the registry shows done. */
export type TransferRecorded = 'recorded' | 'held_elsewhere'

export type Completion = {
  domain: RegistryDomain
  recovered: boolean
  nameserverResult: 'applied' | 'rejected' | 'unknown' | 'none'
  nameserverCode: string | null
}

export interface JobStore {
  /** `jobId` claims that job only — to run it now, or in tests. */
  claim(
    worker: string,
    testMode: boolean,
    leaseSeconds: number,
    jobId?: string,
  ): Promise<ClaimedJob | null>
  /** `jobId` is null for calls that belong to no job, such as a portfolio read. */
  recordCall(jobId: string | null, environment: WriteTarget, call: CallRecord): Promise<void>
  completeRegistration(jobId: string, completion: Completion): Promise<void>
  /** Records a renewal's baseline before its first Renew call; returns the one stored. */
  noteRenewalBaseline(jobId: string, expiresAt: string): Promise<string>
  completeRenewal(jobId: string, expiresAt: string, recovered: boolean): Promise<void>
  /** The registry has the request: the code is deleted and the job polls from `pollAfterSeconds`. */
  markTransferSubmitted(jobId: string, pollAfterSeconds: number): Promise<void>
  /**
   * The domain is ours at the registry. `held_elsewhere`: another account here
   * already holds the name, so this line's transfer is not what put it there.
   */
  completeTransfer(
    jobId: string,
    domain: RegistryDomain & { expiresAt: string },
    recovered: boolean,
  ): Promise<TransferRecorded>
  /** `applied` null means the registry refused `attempted`. */
  recordNameserverChange(
    jobId: string,
    attempted: string[],
    applied: string[] | null,
    code: string | null,
  ): Promise<void>
  /**
   * A settings job's answer (migrations 26, 29). `applied` is what the
   * registry now holds — {transfer_lock}, {privacy} or {registrant, contacts}
   * — read back after the write; null means it refused `attempted`, with `code`.
   */
  recordDomainChange(
    jobId: string,
    attempted: Record<string, unknown>,
    applied: Record<string, unknown> | null,
    code: string | null,
  ): Promise<void>
  reschedule(jobId: string, delaySeconds: number, code: string, message: string): Promise<void>
  fail(jobId: string, code: string, message: string, needsAttention: boolean): Promise<void>
}

type Row = {
  id: string
  kind: ClaimedJob['kind']
  attempts: number
  test_mode: boolean
  domain_id: string
  domain_name: string
  local_status: string
  privacy: boolean
  registrant: unknown
  pending_nameservers: string[] | null
  period_years: number | null
  expires_at?: string | null
  baseline_expiry?: string | null
  payment?: {
    order_tx_ref: string | null
    order_total_kobo: number | string | null
    reference: string | null
    amount_kobo: number | string | null
    currency: string | null
    status: string | null
  } | null
  source?: string | null
  pending_transfer_lock?: boolean | null
  pending_privacy?: boolean | null
  pending_registrant?: unknown
  contacts?: unknown
  pending_contacts?: unknown
  auth_code?: string | null
  submitted_at?: string | null
}

const kobo = (value: number | string | null | undefined) =>
  value === null || value === undefined ? null : Number(value)

export function toClaimedJob(row: Row): ClaimedJob {
  return {
    id: row.id,
    kind: row.kind,
    attempts: row.attempts,
    testMode: row.test_mode,
    domainId: row.domain_id,
    domainName: row.domain_name,
    localStatus: row.local_status,
    privacy: row.privacy,
    registrant: row.registrant,
    pendingNameservers: row.pending_nameservers,
    periodYears: row.period_years,
    expiresAt: row.expires_at ?? null,
    baselineExpiry: row.baseline_expiry ?? null,
    payment: row.payment
      ? {
          orderTxRef: row.payment.order_tx_ref ?? '',
          orderTotalKobo: kobo(row.payment.order_total_kobo) ?? 0,
          reference: row.payment.reference,
          amountKobo: kobo(row.payment.amount_kobo),
          currency: row.payment.currency,
          status: row.payment.status,
        }
      : null,
    source: row.source ?? null,
    pendingTransferLock: row.pending_transfer_lock ?? null,
    pendingPrivacy: row.pending_privacy ?? null,
    pendingRegistrant: row.pending_registrant ?? null,
    contacts: row.contacts ?? null,
    pendingContacts: row.pending_contacts ?? null,
    authCode: row.auth_code ?? null,
    submittedAt: row.submitted_at ?? null,
  }
}

/** Postgres's unique_violation: here, `domains_held_name_unique`. */
const UNIQUE_VIOLATION = '23505'

/** The generated types mark every function argument required and non-null; SQL accepts null. */
const nullable = <T>(value: T | null) => value as T

export function createSupabaseStore(
  client: SupabaseClient<Database> = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SECRET_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  ),
): JobStore {
  async function rpc(result: PromiseLike<{ error: { message: string } | null }>) {
    const { error } = await result
    if (error) throw new Error(error.message)
  }

  return {
    async claim(worker, testMode, leaseSeconds, jobId) {
      const { data, error } = await client.rpc('claim_job', {
        p_worker: worker,
        p_test_mode: testMode,
        p_lease_seconds: leaseSeconds,
        ...(jobId ? { p_job_id: jobId } : {}),
      })
      if (error) throw new Error(error.message)
      return data ? toClaimedJob(data as unknown as Row) : null
    },

    async recordCall(jobId, environment, call) {
      await rpc(
        client.from('supplier_calls').insert({
          job_id: jobId,
          environment,
          operation: call.operation,
          domain_name: call.domainName,
          outcome: call.outcome,
          http_status: call.httpStatus,
          error_code: call.errorCode,
          message: call.message,
          duration_ms: call.durationMs,
        }),
      )
    },

    async completeRegistration(jobId, { domain, recovered, nameserverResult, nameserverCode }) {
      await rpc(
        client.rpc('complete_registration', {
          p_job_id: jobId,
          p_registered_at: nullable(domain.registeredAt),
          p_expires_at: nullable(domain.expiresAt),
          p_nameservers: domain.nameservers,
          p_transfer_lock: domain.transferLock,
          p_privacy: domain.privacy,
          p_recovered: recovered,
          p_nameserver_result: nameserverResult,
          p_nameserver_code: nullable(nameserverCode),
        }),
      )
    },

    async noteRenewalBaseline(jobId, expiresAt) {
      const { data, error } = await client.rpc('note_renewal_baseline', {
        p_job_id: jobId,
        p_expires_at: expiresAt,
      })
      if (error) throw new Error(error.message)
      return String(data)
    },

    async completeRenewal(jobId, expiresAt, recovered) {
      await rpc(
        client.rpc('complete_renewal', {
          p_job_id: jobId,
          p_expires_at: expiresAt,
          p_recovered: recovered,
        }),
      )
    },

    async markTransferSubmitted(jobId, pollAfterSeconds) {
      await rpc(
        client.rpc('mark_transfer_submitted', {
          p_job_id: jobId,
          p_poll_after_seconds: pollAfterSeconds,
        }),
      )
    },

    async completeTransfer(jobId, domain, recovered) {
      const { error } = await client.rpc('complete_transfer', {
        p_job_id: jobId,
        p_registered_at: nullable(domain.registeredAt),
        p_expires_at: domain.expiresAt,
        p_nameservers: domain.nameservers,
        p_transfer_lock: domain.transferLock,
        p_privacy: domain.privacy,
        p_recovered: recovered,
      })
      // Another account here holds the name while it is active (migration 13's
      // index), so the transaction rolled back: nothing was recorded.
      if (error?.code === UNIQUE_VIOLATION) return 'held_elsewhere'
      if (error) throw new Error(error.message)
      return 'recorded'
    },

    async recordNameserverChange(jobId, attempted, applied, code) {
      await rpc(
        client.rpc('record_nameserver_change', {
          p_job_id: jobId,
          p_attempted: attempted,
          p_applied: nullable(applied),
          p_code: nullable(code),
        }),
      )
    },

    async recordDomainChange(jobId, attempted, applied, code) {
      await rpc(
        client.rpc('record_domain_change', {
          p_job_id: jobId,
          p_attempted: attempted as Json,
          p_applied: nullable(applied as Json),
          p_code: nullable(code),
        }),
      )
    },

    async reschedule(jobId, delaySeconds, code, message) {
      await rpc(
        client.rpc('reschedule_job', {
          p_job_id: jobId,
          p_delay_seconds: delaySeconds,
          p_code: code,
          p_message: message,
        }),
      )
    },

    async fail(jobId, code, message, needsAttention) {
      await rpc(
        client.rpc('fail_job', {
          p_job_id: jobId,
          p_code: code,
          p_message: message,
          p_needs_attention: needsAttention,
        }),
      )
    },
  }
}
