import type { Database, Json } from '@dr/db'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { env } from '../env'
import type { Comparison, OurDomain } from './compare'

/** A reconciliation run's database side (migration 14). */
export interface ReconcileStore {
  /** Null when a run finished within the interval, or one is still going. */
  begin(testMode: boolean, minIntervalSeconds: number): Promise<string | null>
  loadOurs(testMode: boolean): Promise<OurDomain[]>
  record(runId: string, comparison: Comparison, domainsSeen: number): Promise<number>
  fail(runId: string, error: string): Promise<void>
}

const PAGE = 1_000

export function createReconcileStore(
  client: SupabaseClient<Database> = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SECRET_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  ),
): ReconcileStore {
  return {
    async begin(testMode, minIntervalSeconds) {
      const { data, error } = await client.rpc('begin_reconcile', {
        p_test_mode: testMode,
        p_min_interval_seconds: minIntervalSeconds,
      })
      if (error) throw new Error(error.message)
      return data ?? null
    },

    async loadOurs(testMode) {
      const rows: OurDomain[] = []
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await client
          .from('domains')
          .select(
            'id, domain_name, local_status, expires_at, nameservers, pending_nameservers, auto_renew, transfer_lock, privacy_enabled',
          )
          .eq('test_mode', testMode)
          .neq('source', 'demo')
          .order('id')
          .range(from, from + PAGE - 1)
        if (error) throw new Error(error.message)
        for (const row of data ?? []) {
          rows.push({
            id: row.id,
            domainName: row.domain_name,
            localStatus: row.local_status,
            expiresAt: row.expires_at,
            nameservers: row.nameservers,
            pendingNameservers: row.pending_nameservers,
            autoRenew: row.auto_renew,
            transferLock: row.transfer_lock,
            privacy: row.privacy_enabled,
          })
        }
        if ((data ?? []).length < PAGE) return rows
      }
    },

    async record(runId, { updates, findings }, domainsSeen) {
      const { data, error } = await client.rpc('record_reconciliation', {
        p_run_id: runId,
        p_updates: updates.map((update) => ({
          domain_id: update.domainId,
          registry_status: update.registryStatus,
          renewal_mode: update.renewalMode,
          expires_at: update.expiresAt ?? null,
          nameservers: update.nameservers ?? null,
          transfer_lock: update.transferLock ?? null,
          privacy: update.privacy ?? null,
          events: update.events,
        })) as unknown as Json,
        p_findings: findings.map((finding) => ({
          domain_id: finding.domainId,
          domain_name: finding.domainName,
          kind: finding.kind,
          detail: finding.detail,
        })) as unknown as Json,
        p_complete: true,
        p_domains_seen: domainsSeen,
      })
      if (error) throw new Error(error.message)
      return data ?? 0
    },

    async fail(runId, message) {
      const { error } = await client.rpc('fail_reconcile', { p_run_id: runId, p_error: message })
      if (error) throw new Error(error.message)
    },
  }
}
