import type { Database } from '@dr/db'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { WriteTarget } from '../dna/client'
import { env } from '../env'
import type { CallRecord, RegistryDomain } from './registrar'

/**
 * The job queue, as the worker sees it. Each method is one database function
 * (migration 13), so a job, its order line, its domain and its order change
 * in one transaction or not at all.
 */

export type ClaimedJob = {
  id: string
  kind: 'register_domain' | 'apply_nameservers'
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
}

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
  /** `applied` null means the registry refused `attempted`. */
  recordNameserverChange(
    jobId: string,
    attempted: string[],
    applied: string[] | null,
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
}

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
  }
}

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
