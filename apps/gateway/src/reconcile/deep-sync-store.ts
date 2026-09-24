import type { Database, Json } from '@dr/db'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { env } from '../env'
import type { DomainUpdate, Finding, OurDomain } from './compare'

/**
 * The deep sync's database side (migration 32). `domains_for_deep_sync`
 * picks live, non-demo domains due a read of their own: never read, read
 * over a day ago, or changed since. `record_deep_sync` applies one reading
 * the way `record_reconciliation` applies a run's, then stamps the domain.
 */

/** One domain's reading. A null update means the registry agreed: stamp only. */
export type DeepReading = { update: DomainUpdate | null; findings: Finding[] }

export interface DeepSyncStore {
  /** Least recently read first. */
  due(testMode: boolean, limit: number): Promise<OurDomain[]>
  record(domainId: string, testMode: boolean, reading: DeepReading): Promise<void>
}

export function createDeepSyncStore(
  client: SupabaseClient<Database> = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SECRET_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  ),
): DeepSyncStore {
  return {
    async due(testMode, limit) {
      const { data, error } = await client.rpc('domains_for_deep_sync', {
        p_test_mode: testMode,
        p_limit: limit,
      })
      if (error) throw new Error(error.message)
      // The generated types call every column non-null; expiry and the
      // nameserver lists can be null.
      return (data ?? []).map((row) => ({
        id: row.domain_id,
        domainName: row.domain_name,
        localStatus: row.local_status,
        expiresAt: row.expires_at ?? null,
        nameservers: row.nameservers ?? null,
        pendingNameservers: row.pending_nameservers ?? null,
        autoRenew: row.auto_renew,
        transferLock: row.transfer_lock,
        privacy: row.privacy,
      }))
    },

    async record(domainId, testMode, { update, findings }) {
      const { error } = await client.rpc('record_deep_sync', {
        p_domain_id: domainId,
        p_test_mode: testMode,
        // The shape of one record_reconciliation update, without its domain_id.
        // A null field keeps what we hold: a status or renewal mode the
        // answer did not carry is never cleared.
        p_update: update
          ? ({
              registry_status: update.registryStatus || null,
              renewal_mode: update.renewalMode,
              expires_at: update.expiresAt ?? null,
              nameservers: update.nameservers ?? null,
              transfer_lock: update.transferLock ?? null,
              privacy: update.privacy ?? null,
              events: update.events,
            } as unknown as Json)
          : null,
        p_findings: findings.map((finding) => ({
          kind: finding.kind,
          detail: finding.detail,
        })) as unknown as Json,
      })
      if (error) throw new Error(error.message)
    },
  }
}
