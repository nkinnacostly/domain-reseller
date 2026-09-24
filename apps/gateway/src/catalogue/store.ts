import type { Database, Json } from '@dr/db'
import type { SupabaseClient } from '@supabase/supabase-js'
import { CURRENT_TLD_COLUMNS, type CurrentTld, type TldRow } from './catalogue'

/**
 * The catalogue's database side: the `tlds` table, and the heartbeat row
 * where each scheduled run leaves its outcome (migration 15). Takes a client
 * rather than reading the gateway's env, so the CLI script can use it with
 * the few variables it has.
 */
export interface CatalogueStore {
  load(): Promise<CurrentTld[]>
  /** Writes in batches: Postgres rejects very large single statements. */
  upsert(rows: TldRow[], syncedAt: string): Promise<void>
  /** Extensions the supplier dropped stay in the table but stop being sold. */
  retire(names: string[]): Promise<void>
}

const PAGE = 1_000

export function createCatalogueStore(
  client: SupabaseClient<Database>,
  batchSize = 200,
): CatalogueStore {
  return {
    async load() {
      // Paged: PostgREST caps an answer at 1,000 rows, and a short read here
      // would report every extension past the cap as new.
      const rows: CurrentTld[] = []
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await client
          .from('tlds')
          .select(CURRENT_TLD_COLUMNS)
          .order('name')
          .range(from, from + PAGE - 1)
        if (error) throw new Error(`Could not read the current catalogue: ${error.message}`)
        rows.push(...((data ?? []) as CurrentTld[]))
        if ((data ?? []).length < PAGE) return rows
      }
    },

    async upsert(rows, syncedAt) {
      for (let at = 0; at < rows.length; at += batchSize) {
        const batch = rows.slice(at, at + batchSize).map((row) => ({ ...row, synced_at: syncedAt }))
        const { error } = await client.from('tlds').upsert(batch, { onConflict: 'name' })
        if (error) throw new Error(`Upsert failed at row ${at}: ${error.message}`)
      }
    },

    async retire(names) {
      for (let at = 0; at < names.length; at += batchSize) {
        const { error } = await client
          .from('tlds')
          .update({ is_sellable: false })
          .in('name', names.slice(at, at + batchSize))
        if (error) throw new Error(`Could not retire removed extensions: ${error.message}`)
      }
    },
  }
}

export type LastRun = { at: Date; detail: Record<string, unknown> }

/**
 * The last scheduled run, kept in `service_heartbeats`: when it ran and what
 * came of it. It is how a restarted gateway knows the week's sync is done,
 * and how a failing one shows up without reading logs.
 */
export interface RunLog {
  last(): Promise<LastRun | null>
  record(detail: Record<string, unknown>): Promise<void>
}

export const CATALOGUE_HEARTBEAT = 'catalogue:production'

export function createRunLog(client: SupabaseClient<Database>, name = CATALOGUE_HEARTBEAT): RunLog {
  return {
    async last() {
      const { data, error } = await client
        .from('service_heartbeats')
        .select('beat_at, detail')
        .eq('name', name)
        .maybeSingle()
      if (error) throw new Error(`Could not read the last catalogue sync: ${error.message}`)
      if (!data) return null
      const detail =
        typeof data.detail === 'object' && data.detail !== null && !Array.isArray(data.detail)
          ? (data.detail as Record<string, unknown>)
          : {}
      return { at: new Date(data.beat_at), detail }
    },

    async record(detail) {
      const { error } = await client.rpc('record_heartbeat', {
        p_name: name,
        // The live catalogue: it prices every real order.
        p_test_mode: false,
        p_detail: detail as Json,
      })
      if (error) throw new Error(`Could not record the catalogue sync: ${error.message}`)
    },
  }
}
