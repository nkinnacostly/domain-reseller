import type { Database, Json } from '@dr/db'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CheckedStatus, CurrentStatus } from './judge'
import type { ResolverView } from './resolvers'

/**
 * The delegation check's database side (migration 26). The functions pick
 * live, non-demo domains only — sandbox names are not in public DNS — and
 * record a delegation_verified or delegation_failed event when the status
 * changes.
 */

export type DueDomain = {
  id: string
  domainName: string
  nameservers: string[]
  status: CurrentStatus
}

export type DelegationResult = {
  domainId: string
  status: CheckedStatus
  observed: ResolverView[]
}

export interface DelegationStore {
  /** Least recently checked first. */
  due(limit: number, everyHours: number): Promise<DueDomain[]>
  /** When each domain's nameservers last changed, from its activity log. */
  lastChanges(domainIds: string[]): Promise<Map<string, Date>>
  record(results: DelegationResult[]): Promise<number>
}

/**
 * Every way a domain's nameservers come to be what we hold: registered,
 * changed by the customer, transferred in, or copied from the registry.
 */
export const NAMESERVER_CHANGE_EVENTS = [
  'registered',
  'nameservers_applied',
  'transferred_in',
  'nameservers_synced',
]

export function createDelegationStore(client: SupabaseClient<Database>): DelegationStore {
  return {
    async due(limit, everyHours) {
      const { data, error } = await client.rpc('domains_for_delegation_check', {
        p_limit: limit,
        p_every_hours: everyHours,
      })
      if (error) throw new Error(error.message)
      return (data ?? []).map((row) => ({
        id: row.domain_id,
        domainName: row.domain_name,
        nameservers: row.nameservers ?? [],
        status: row.delegation_status,
      }))
    },

    async lastChanges(domainIds) {
      const changes = new Map<string, Date>()
      if (domainIds.length === 0) return changes
      const { data, error } = await client
        .from('domain_events')
        .select('domain_id, created_at')
        .in('domain_id', domainIds)
        .in('event_type', NAMESERVER_CHANGE_EVENTS)
        .order('created_at', { ascending: false })
      if (error) throw new Error(error.message)
      for (const row of data ?? []) {
        if (!changes.has(row.domain_id)) changes.set(row.domain_id, new Date(row.created_at))
      }
      return changes
    },

    async record(results) {
      if (results.length === 0) return 0
      const { data, error } = await client.rpc('record_delegation_checks', {
        p_results: results.map((result) => ({
          domain_id: result.domainId,
          status: result.status,
          observed: result.observed,
        })) as unknown as Json,
      })
      if (error) throw new Error(error.message)
      return data ?? 0
    },
  }
}
