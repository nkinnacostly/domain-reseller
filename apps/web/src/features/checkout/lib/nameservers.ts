import { nameserverSetSchema } from '@dr/shared'

/**
 * FR-C10 — nameservers pasted at checkout, one per line or separated by
 * commas or spaces, the way hosts hand them out. Empty means "later".
 */
export type NameserverParse =
  | { ok: true; nameservers: string[] | null }
  | { ok: false; error: string }

export function parseNameservers(raw: string | undefined): NameserverParse {
  const entries = (raw ?? '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean)
  if (entries.length === 0) return { ok: true, nameservers: null }

  const parsed = nameserverSetSchema.safeParse(entries)
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the nameservers' }
  return { ok: true, nameservers: parsed.data }
}

/**
 * FR-C10's three ways at checkout: leave the registrar's default in place,
 * pick a host from our presets, or enter nameservers by hand.
 */
export type NameserverMode = 'default' | 'preset' | 'manual'

export type NameserverRequest =
  | { ok: true; nameservers: string; presetId?: string }
  | { ok: false; error: string }

/**
 * What the checkout form sends for the choice. Only the chosen way travels —
 * typed nameservers left behind after switching to a preset are not sent —
 * and a choice that cannot work is caught before the order is tried.
 */
export function nameserverRequest(
  mode: string,
  presetId: string,
  typed: string,
  presets: { id: string; provider: string; assignsPerZone: boolean }[],
): NameserverRequest {
  if (mode === 'preset') {
    const preset = presets.find((candidate) => candidate.id === presetId)
    if (!preset) return { ok: false, error: 'Choose your host, or pick another option.' }
    if (preset.assignsPerZone) {
      return {
        ok: false,
        error: `Choose another option to continue: ${preset.provider}'s nameservers can only be added once the domain is registered.`,
      }
    }
    return { ok: true, nameservers: '', presetId: preset.id }
  }
  return { ok: true, nameservers: mode === 'manual' ? typed : '' }
}

/** A `nameserver_presets` row as the server reads it back, hidden or not. */
export type PresetRow = {
  id: string
  provider: string
  nameservers: string[]
  assigns_per_zone: boolean
  verified_at: string | null
  is_hidden: boolean
}

export type PresetChoice =
  | { ok: true; nameservers: string[] }
  | { ok: false; reason: 'unavailable' | 'per_zone' | 'invalid'; error: string }

const PRESET_UNAVAILABLE =
  'That host is no longer on our list. Choose another, or enter the nameservers your host gave you.'

/** FR-D3 — why a per-zone provider cannot be chosen before the domain exists. */
export function perZoneExplanation(provider: string): string {
  return `${provider} gives each domain its own nameservers once it is added to your ${provider} account, so they cannot be set before the domain is registered. Leave the registrar's default for now, then add them from the domain's Nameservers tab.`
}

/**
 * FR-C10 with FR-D2/FR-D3 — the nameservers a host preset stands for, read
 * from our own table, never from the browser (N11). Hidden and unverified
 * presets are never used, even by id. A provider that assigns a pair per
 * zone has nothing to set until the domain exists and is added there.
 */
export function presetNameservers(preset: PresetRow | null): PresetChoice {
  if (!preset || preset.is_hidden || !preset.verified_at) {
    return { ok: false, reason: 'unavailable', error: PRESET_UNAVAILABLE }
  }
  if (preset.assigns_per_zone) {
    return { ok: false, reason: 'per_zone', error: perZoneExplanation(preset.provider) }
  }
  const parsed = nameserverSetSchema.safeParse(preset.nameservers)
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'invalid',
      error: `We can't use our saved nameservers for ${preset.provider} right now. Enter the ones your host gave you instead.`,
    }
  }
  return { ok: true, nameservers: parsed.data }
}
