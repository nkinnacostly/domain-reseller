import type { Database } from '@dr/db'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { env } from '../env'

/**
 * Ops alerts as the monitor sees them (migration 15). The database decides
 * what is wrong and when to repeat it; the monitor only delivers.
 */

const dueSchema = z.array(
  z.object({
    id: z.coerce.number().int(),
    type: z.enum(['new', 'reminder', 'resolved']),
    severity: z.enum(['critical', 'warning']),
    kind: z.string(),
    summary: z.string(),
    first_seen_at: z.string(),
  }),
)

export type DueAlert = {
  id: number
  type: 'new' | 'reminder' | 'resolved'
  severity: 'critical' | 'warning'
  kind: string
  summary: string
  firstSeenAt: string
  /** `job:<id>`, `refund:<id>`… — for the admin link (ADMIN-SPEC §4.5). sync_alerts returns none. */
  key?: string
}

export interface AlertStore {
  heartbeat(name: string, testMode: boolean, detail: Record<string, unknown>): Promise<void>
  recordBalance(testMode: boolean, balanceUsd: number): Promise<void>
  /** Brings alerts in line with what is wrong now, and returns what to send. */
  sync(testMode: boolean): Promise<DueAlert[]>
  markNotified(alertIds: number[], resolvedIds: number[]): Promise<void>
}

export function toDueAlerts(raw: unknown): DueAlert[] {
  return dueSchema.parse(raw ?? []).map((row) => ({
    id: row.id,
    type: row.type,
    severity: row.severity,
    kind: row.kind,
    summary: row.summary,
    firstSeenAt: row.first_seen_at,
  }))
}

export function createAlertStore(
  client: SupabaseClient<Database> = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SECRET_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  ),
): AlertStore {
  async function rpc(result: PromiseLike<{ error: { message: string } | null }>) {
    const { error } = await result
    if (error) throw new Error(error.message)
  }

  return {
    heartbeat: (name, testMode, detail) =>
      rpc(
        client.rpc('record_heartbeat', {
          p_name: name,
          p_test_mode: testMode,
          p_detail: detail as never,
        }),
      ),
    recordBalance: (testMode, balanceUsd) =>
      rpc(
        client.rpc('record_supplier_balance', {
          p_test_mode: testMode,
          p_balance_usd: balanceUsd,
        }),
      ),
    async sync(testMode) {
      const { data, error } = await client.rpc('sync_alerts', { p_test_mode: testMode })
      if (error) throw new Error(error.message)
      const due = toDueAlerts(data)
      if (due.length === 0) return due
      // sync_alerts is unchanged and returns no key; the service key reads
      // them from ops_alerts for the admin links. Without them the alerts
      // still go out, unlinked.
      const { data: keys, error: keyError } = await client
        .from('ops_alerts')
        .select('id, key')
        .in(
          'id',
          due.map((alert) => alert.id),
        )
      if (keyError) return due
      const byId = new Map((keys ?? []).map((row) => [Number(row.id), row.key]))
      return due.map((alert) => {
        const key = byId.get(alert.id)
        return key ? { ...alert, key } : alert
      })
    },
    markNotified: (alertIds, resolvedIds) =>
      rpc(
        client.rpc('mark_alerts_notified', {
          p_alert_ids: alertIds,
          p_resolved_ids: resolvedIds,
        }),
      ),
  }
}
