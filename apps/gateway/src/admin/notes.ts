import type { Database, Json } from '@dr/db'
import type { AdminGatewayAction, AdminNoteSide } from '@dr/shared/admin'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { WriteTarget } from '../dna/client'
import type { CallRecord } from '../provisioning/registrar'

/**
 * The gateway's side of the admin audit trail (migration 40). A route claims
 * the web's intent note before anything else (admin_claim_note: right
 * action, admin, side and target, under a minute old, unused) and records
 * what happened against it (admin_note_result). Details carry ids, counts
 * and cents — never a name's contacts, never a body (N13).
 */

export type ClaimRefusal =
  | 'NOT_FOUND'
  | 'NOT_INTENT'
  | 'ACTION_MISMATCH'
  | 'LABEL_MISMATCH'
  | 'TARGET_MISMATCH'
  | 'SIDE_MISMATCH'
  | 'EXPIRED'
  | 'USED'
  | 'TEST_ADMIN'
  | 'REVOKED'

export type Claim = { ok: true } | { ok: false; code: ClaimRefusal | string }

export type NoteOutcome = 'ok' | 'refused' | 'failed'

export interface NoteStore {
  claim(
    auditId: number,
    action: AdminGatewayAction,
    label: string,
    side: AdminNoteSide,
    targetId: string,
  ): Promise<Claim>
  result(
    auditId: number,
    outcome: NoteOutcome,
    code: string | null,
    detail: Record<string, unknown>,
  ): Promise<void>
}

export type FlwCheckFacts = {
  auditId: number
  testMode: boolean
  targetType: 'refund' | 'incident'
  targetId: string
  flwRefundId: string
  transactionId: string | null
  amountKobo: number
  status: string
  disburseStatus: string | null
  state: 'done' | 'failed' | 'pending'
}

export type DraftForCheck = { id: string; provider: string; nameservers: string[] }

/** The few reads and writes the admin routes make beside the notes. */
export interface AdminStore {
  /** I7: an admin read is a supplier call like any other — identifiers and outcome only. */
  recordCall(environment: WriteTarget, call: CallRecord): Promise<void>
  recordFlwCheck(facts: FlwCheckFacts): Promise<number>
  /** What `tlds` says the supplier charges, for the price check. Null: not in the catalogue. */
  tldCost(tld: string): Promise<{
    registerUsd: number
    renewUsd: number
    transferUsd: number | null
    restoreUsd: number | null
    firstTermYears: number
  } | null>
  /** An open draft due a public-DNS check, or null. */
  draft(id: string): Promise<DraftForCheck | null>
}

function fail(error: { message: string } | null): void {
  if (error) throw new Error(error.message)
}

export function createNoteStore(client: SupabaseClient<Database>): NoteStore {
  return {
    async claim(auditId, action, label, side, targetId) {
      const { data, error } = await client.rpc('admin_claim_note', {
        p_audit_id: auditId,
        p_action: action,
        p_label: label,
        p_side: side,
        p_target_id: targetId,
      })
      fail(error)
      const answer = (data ?? {}) as { ok?: unknown; code?: unknown }
      if (answer.ok === true) return { ok: true }
      return { ok: false, code: typeof answer.code === 'string' ? answer.code : 'NOT_FOUND' }
    },
    async result(auditId, outcome, code, detail) {
      const { error } = await client.rpc('admin_note_result', {
        p_audit_id: auditId,
        p_outcome: outcome,
        // An empty code is stored as none.
        p_code: code ?? '',
        p_detail: detail as Json,
      })
      fail(error)
    },
  }
}

export function createAdminStore(client: SupabaseClient<Database>): AdminStore {
  return {
    async recordCall(environment, call) {
      const { error } = await client.from('supplier_calls').insert({
        job_id: null,
        environment,
        operation: call.operation,
        domain_name: call.domainName,
        outcome: call.outcome,
        http_status: call.httpStatus,
        error_code: call.errorCode,
        message: call.message,
        duration_ms: call.durationMs,
      })
      fail(error)
    },
    async recordFlwCheck(facts) {
      const { data, error } = await client.rpc('record_flw_refund_check', {
        p_audit_id: facts.auditId,
        p_test_mode: facts.testMode,
        p_target_type: facts.targetType,
        p_target_id: facts.targetId,
        p_flw_refund_id: facts.flwRefundId,
        p_tx_id: facts.transactionId ?? '',
        p_amount_kobo: facts.amountKobo,
        p_currency: 'NGN',
        p_status: facts.status,
        p_disburse_status: facts.disburseStatus ?? '',
        p_state: facts.state,
      })
      fail(error)
      return Number(data)
    },
    async tldCost(tld) {
      const { data, error } = await client
        .from('tlds')
        .select('register_usd, renew_usd, transfer_usd, restore_usd, register_periods, min_period')
        .eq('name', tld)
        .maybeSingle()
      fail(error)
      if (!data) return null
      return {
        registerUsd: Number(data.register_usd),
        renewUsd: Number(data.renew_usd),
        transferUsd: data.transfer_usd === null ? null : Number(data.transfer_usd),
        restoreUsd: data.restore_usd === null ? null : Number(data.restore_usd),
        firstTermYears: data.register_periods?.[0] ?? data.min_period ?? 1,
      }
    },
    async draft(id) {
      const { data, error } = await client.rpc('preset_drafts_for_check')
      fail(error)
      const row = (data ?? []).find((draft) => draft.draft_id === id)
      return row
        ? { id: row.draft_id, provider: row.provider, nameservers: row.nameservers ?? [] }
        : null
    },
  }
}
