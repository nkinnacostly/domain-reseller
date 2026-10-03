import type { Database, Json } from '@dr/db'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { LedgerRow } from './normalize'

/**
 * The mirror's database side (migration 41): record_supplier_ledger inserts
 * new entries, applies status changes, keeps any other change as a revision
 * and re-matches; the heartbeat says how the last read went.
 */

export type LedgerRecorded = { inserted: number; statusChanged: number; revised: number }

export interface LedgerStore {
  /** The newest entry the mirror holds for a side, or null before the first sync. */
  latestOccurredAt(testMode: boolean): Promise<Date | null>
  record(testMode: boolean, rows: LedgerRow[]): Promise<LedgerRecorded>
  /** When the last complete read began, from the heartbeat; null if never. */
  lastOkReadAt(name: string): Promise<string | null>
  beat(name: string, testMode: boolean, detail: Record<string, unknown>): Promise<void>
}

export function createLedgerStore(client: SupabaseClient<Database>): LedgerStore {
  return {
    async latestOccurredAt(testMode) {
      const { data, error } = await client
        .from('supplier_ledger_entries')
        .select('occurred_at')
        .eq('test_mode', testMode)
        .order('occurred_at', { ascending: false })
        .limit(1)
      if (error) throw new Error(error.message)
      const at = data?.[0]?.occurred_at
      return at ? new Date(at) : null
    },

    async record(testMode, rows) {
      const { data, error } = await client.rpc('record_supplier_ledger', {
        p_test_mode: testMode,
        p_rows: rows as unknown as Json,
      })
      if (error) throw new Error(error.message)
      const answer = (data ?? {}) as Record<string, unknown>
      return {
        inserted: Number(answer.inserted ?? 0),
        statusChanged: Number(answer.statusChanged ?? 0),
        revised: Number(answer.revised ?? 0),
      }
    },

    async lastOkReadAt(name) {
      const { data, error } = await client
        .from('service_heartbeats')
        .select('detail')
        .eq('name', name)
        .maybeSingle()
      if (error) throw new Error(error.message)
      const detail = (data?.detail ?? {}) as Record<string, unknown>
      const value = detail.outcome === 'ok' ? detail.readAt : detail.lastOkReadAt
      return typeof value === 'string' ? value : null
    },

    async beat(name, testMode, detail) {
      const { error } = await client.rpc('record_heartbeat', {
        p_name: name,
        p_test_mode: testMode,
        p_detail: detail as Json,
      })
      if (error) throw new Error(error.message)
    },
  }
}
