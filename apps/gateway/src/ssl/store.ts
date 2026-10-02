import type { Database } from '@dr/db'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { WriteTarget } from '../dna/client'
import { env } from '../env'
import type { PaymentFacts } from '../payments/charge-check'
import type { CallRecord } from '../provisioning/registrar'
import type { Bought } from './jobs'
import type { SslState } from './status'

/**
 * The SSL queue and certificates, as the gateway sees them. Every method is
 * one database function (migration 39): a job, its certificate, its order
 * line and its order move in one transaction or not at all.
 */

export type ClaimedSslJob = {
  id: string
  /** A string, not a union: a kind this build does not know is held, never guessed. */
  kind: string
  attempts: number
  testMode: boolean
  sentAt: string | null
  certificateId: string
  /** The name every supplier call uses: example.com or *.example.com. */
  commonName: string
  productCode: string
  isWildcard: boolean
  includedNames: number
  status: string
  csr: string | null
  approverEmail: string | null
  webServer: string | null
  sanNames: string[]
  contact: unknown
  nameTaken: boolean
  /** For an order: the charge that paid for it, confirmed with Flutterwave first. */
  payment: PaymentFacts | null
}

export type CertificateToCheck = {
  id: string
  commonName: string
  status: string
  isWildcard: boolean
  configuredAt: string | null
  hasCertificate: boolean
}

export type StatusRecord = {
  supplierStatus: string
  state: SslState | null
  issuedAt: string | null
  expiresAt: string | null
  certificate: string | null
  caBundle: string | null
  nextCheckSeconds: number
}

/** What became of recording a purchase. */
export type BoughtRecorded = 'recorded' | 'name_held_here'

export interface SslStore {
  claim(
    worker: string,
    testMode: boolean,
    leaseSeconds: number,
    jobId?: string,
  ): Promise<ClaimedSslJob | null>
  recordCall(jobId: string | null, environment: WriteTarget, call: CallRecord): Promise<void>
  noteSent(jobId: string): Promise<string>
  completeInitialize(jobId: string, bought: Bought, recovered: boolean): Promise<BoughtRecorded>
  recordConfigured(jobId: string, supplierStatus: string, recovered: boolean): Promise<void>
  refuseSetup(jobId: string, code: string, message: string): Promise<void>
  recordReissue(
    jobId: string,
    supplierStatus: string,
    state: 'awaiting_setup' | 'awaiting_validation' | 'issued',
    recovered: boolean,
  ): Promise<void>
  reschedule(jobId: string, delaySeconds: number, code: string, message: string): Promise<void>
  fail(jobId: string, code: string, message: string, needsAttention: boolean): Promise<void>
  toCheck(testMode: boolean, limit: number): Promise<CertificateToCheck[]>
  recordStatus(certificateId: string, record: StatusRecord): Promise<void>
}

type Row = {
  id: string
  kind: string
  attempts: number
  test_mode: boolean
  sent_at: string | null
  certificate_id: string
  common_name: string
  product_code: string
  is_wildcard: boolean
  included_names: number
  status: string
  csr: string | null
  approver_email: string | null
  web_server: string | null
  san_names: string[] | null
  contact: unknown
  name_taken: boolean
  payment: {
    order_tx_ref: string | null
    order_total_kobo: number | string | null
    reference: string | null
    amount_kobo: number | string | null
    currency: string | null
    status: string | null
  } | null
}

const kobo = (value: number | string | null | undefined) =>
  value === null || value === undefined ? null : Number(value)

export function toClaimedSslJob(row: Row): ClaimedSslJob {
  return {
    id: row.id,
    kind: row.kind,
    attempts: row.attempts,
    testMode: row.test_mode,
    sentAt: row.sent_at ?? null,
    certificateId: row.certificate_id,
    commonName: row.common_name,
    productCode: row.product_code,
    isWildcard: row.is_wildcard,
    includedNames: row.included_names,
    status: row.status,
    csr: row.csr ?? null,
    approverEmail: row.approver_email ?? null,
    webServer: row.web_server ?? null,
    sanNames: row.san_names ?? [],
    contact: row.contact ?? null,
    nameTaken: row.name_taken === true,
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
  }
}

/** Postgres's unique_violation: here, ssl_certificates_one_per_name. */
const UNIQUE_VIOLATION = '23505'

/** The generated types mark every function argument required and non-null; SQL accepts null. */
const nullable = <T>(value: T | null) => value as T

export function createSslStore(
  client: SupabaseClient<Database> = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SECRET_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  ),
): SslStore {
  async function rpc(result: PromiseLike<{ error: { message: string } | null }>) {
    const { error } = await result
    if (error) throw new Error(error.message)
  }

  return {
    async claim(worker, testMode, leaseSeconds, jobId) {
      const { data, error } = await client.rpc('claim_ssl_job', {
        p_worker: worker,
        p_test_mode: testMode,
        p_lease_seconds: leaseSeconds,
        ...(jobId ? { p_job_id: jobId } : {}),
      })
      if (error) throw new Error(error.message)
      return data ? toClaimedSslJob(data as unknown as Row) : null
    },

    async recordCall(jobId, environment, call) {
      // Identifiers and outcomes only: never a body, a CSR or a key (I7, N13).
      await rpc(
        client.from('supplier_calls').insert({
          ssl_job_id: jobId,
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

    async noteSent(jobId) {
      const { data, error } = await client.rpc('note_ssl_job_sent', { p_job_id: jobId })
      if (error) throw new Error(error.message)
      return String(data)
    },

    async completeInitialize(jobId, bought, recovered) {
      const { error } = await client.rpc('complete_ssl_initialize', {
        p_job_id: jobId,
        p_supplier_id: nullable(bought.certificateId),
        p_supplier_status: bought.supplierStatus,
        p_purchased_at: nullable(bought.purchasedAt),
        p_subscription_ends_at: nullable(bought.subscriptionEndsAt),
        p_recovered: recovered,
      })
      // Another certificate here already holds the name: nothing was recorded.
      if (error?.code === UNIQUE_VIOLATION) return 'name_held_here'
      if (error) throw new Error(error.message)
      return 'recorded'
    },

    async recordConfigured(jobId, supplierStatus, recovered) {
      await rpc(
        client.rpc('record_ssl_configured', {
          p_job_id: jobId,
          p_supplier_status: supplierStatus,
          p_recovered: recovered,
        }),
      )
    },

    async refuseSetup(jobId, code, message) {
      await rpc(
        client.rpc('refuse_ssl_setup', { p_job_id: jobId, p_code: code, p_message: message }),
      )
    },

    async recordReissue(jobId, supplierStatus, state, recovered) {
      await rpc(
        client.rpc('record_ssl_reissue', {
          p_job_id: jobId,
          p_supplier_status: supplierStatus,
          p_state: state,
          p_recovered: recovered,
        }),
      )
    },

    async reschedule(jobId, delaySeconds, code, message) {
      await rpc(
        client.rpc('reschedule_ssl_job', {
          p_job_id: jobId,
          p_delay_seconds: delaySeconds,
          p_code: code,
          p_message: message,
        }),
      )
    },

    async fail(jobId, code, message, needsAttention) {
      await rpc(
        client.rpc('fail_ssl_job', {
          p_job_id: jobId,
          p_code: code,
          p_message: message,
          p_needs_attention: needsAttention,
        }),
      )
    },

    async toCheck(testMode, limit) {
      const { data, error } = await client.rpc('ssl_certificates_to_check', {
        p_test_mode: testMode,
        p_limit: limit,
      })
      if (error) throw new Error(error.message)
      return (data ?? []).map((row) => ({
        id: row.id,
        commonName: row.common_name,
        status: row.status,
        isWildcard: row.is_wildcard,
        configuredAt: row.configured_at ?? null,
        hasCertificate: row.has_certificate,
      }))
    },

    async recordStatus(certificateId, record) {
      await rpc(
        client.rpc('record_ssl_status', {
          p_certificate_id: certificateId,
          p_supplier_status: record.supplierStatus,
          p_state: nullable(record.state),
          p_issued_at: nullable(record.issuedAt),
          p_expires_at: nullable(record.expiresAt),
          p_certificate: nullable(record.certificate),
          p_ca_bundle: nullable(record.caBundle),
          p_next_check_seconds: record.nextCheckSeconds,
        }),
      )
    },
  }
}
