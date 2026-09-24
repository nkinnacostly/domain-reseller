import type { Database, Json } from '@dr/db'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AddressView } from './resolvers'

/**
 * The preset check's database side (migration 32). `record_preset_check`
 * decides what a verdict means: a day of failures hides the preset from
 * customers, one pass shows a preset the check hid — never one a person hid.
 * The alert monitor reads the result (preset_failing, preset_hidden).
 */

export type DuePreset = { id: string; provider: string; nameservers: string[] }

export type HostCheck = {
  host: string
  verdict: 'resolves' | 'fails' | 'unanswered'
  views: AddressView[]
}

/** What was seen, kept on the preset for admin. Public hostnames and addresses only. */
export type PresetCheckDetail = { unresolved: string[]; hosts: HostCheck[] }

export type PresetOutcome = 'ok' | 'failing' | 'hidden' | 'restored'

const OUTCOMES = new Set<string>(['ok', 'failing', 'hidden', 'restored'])

export interface PresetStore {
  /** Presets with nameservers of their own: shown ones, and ones the check hid. */
  due(): Promise<DuePreset[]>
  record(presetId: string, ok: boolean, detail: PresetCheckDetail): Promise<PresetOutcome>
}

export function createPresetStore(client: SupabaseClient<Database>): PresetStore {
  return {
    async due() {
      const { data, error } = await client.rpc('presets_for_check')
      if (error) throw new Error(error.message)
      return (data ?? []).map((row) => ({
        id: row.preset_id,
        provider: row.provider,
        nameservers: row.nameservers ?? [],
      }))
    },

    async record(presetId, ok, detail) {
      const { data, error } = await client.rpc('record_preset_check', {
        p_preset_id: presetId,
        p_ok: ok,
        p_detail: detail as unknown as Json,
      })
      if (error) throw new Error(error.message)
      if (typeof data !== 'string' || !OUTCOMES.has(data)) {
        throw new Error(`record_preset_check answered ${JSON.stringify(data)}`)
      }
      return data as PresetOutcome
    },
  }
}
