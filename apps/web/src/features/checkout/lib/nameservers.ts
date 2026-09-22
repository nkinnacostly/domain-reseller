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
