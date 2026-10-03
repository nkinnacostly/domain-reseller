import type { AdminPresetDraftCheck } from '@dr/shared/admin'
import { nameserverSchema } from '@dr/shared/schemas'
import { formatWat, formatWatDate, formatWatTime } from '@/features/admin/lib/format'
import type { Tone } from '@/features/admin/lib/tone'

/**
 * Nameserver presets as the owner works them (docs/ADMIN-SPEC.md §5.2 B13,
 * D21, N11): each preset's health in public DNS, its open draft and what
 * the draft's check found, in words. The nameservers themselves only ever
 * come from the database; nothing here knows a provider's.
 */

export type PresetRow = {
  id: string
  provider: string
  nameservers: string[]
  assignsPerZone: boolean
  sourceUrl: string
  notes: string | null
  verifiedAt: string | null
  lastCheckedAt: string | null
  checkFailedSince: string | null
  autoHiddenAt: string | null
  isHidden: boolean
  registrarDefaultFor: string | null
  lastCheck: CheckDetail | null
}

export type DraftRow = {
  id: string
  presetId: string | null
  provider: string
  nameservers: string[]
  sourceUrl: string
  notes: string | null
  assignsPerZone: boolean
  savedBy: string
  savedAt: string
  checkOk: boolean | null
  checkedAt: string | null
  checkDetail: CheckDetail | null
  publishedAt: string | null
  discardedAt: string | null
}

/** One host's answer in a recorded check: `resolves`, `fails` or `unanswered`. */
export type HostVerdict = { host: string; verdict: string }

/** What the gateway's checker records: `{unresolved, hosts}` (apps/gateway/src/presets). */
export type CheckDetail = { unresolved: string[]; hosts: HostVerdict[] }

export type PresetUsage = { domains: number; orders: number; lines: number }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A stored check's detail, kept to host names and verdicts; anything else is dropped. */
export function checkDetail(value: unknown): CheckDetail | null {
  if (!isRecord(value)) return null
  const hosts = Array.isArray(value.hosts)
    ? value.hosts.flatMap((host) =>
        isRecord(host) && typeof host.host === 'string'
          ? [{ host: host.host, verdict: typeof host.verdict === 'string' ? host.verdict : '' }]
          : [],
      )
    : []
  const unresolved = Array.isArray(value.unresolved)
    ? value.unresolved.filter((host): host is string => typeof host === 'string')
    : []
  return { unresolved, hosts }
}

export const isOpen = (draft: Pick<DraftRow, 'publishedAt' | 'discardedAt'>) =>
  draft.publishedAt === null && draft.discardedAt === null

/** A preset is re-verified against its provider's documentation every 90 days (migration 32). */
export const REVERIFY_DAYS = 90

export function needsReverify(verifiedAt: string | null, now: Date): boolean {
  if (!verifiedAt) return true
  const at = Date.parse(verifiedAt)
  return Number.isNaN(at) || now.getTime() - at > REVERIFY_DAYS * 86_400_000
}

export type Health = { key: string; tone: Tone; words: string }

/**
 * A preset's state in one phrase. Who hid it comes first — the checker
 * (`auto_hidden_at`) or a person — because that decides who can bring it
 * back; then the public-DNS check.
 */
export function presetHealth(preset: PresetRow): Health {
  if (preset.registrarDefaultFor) {
    return { key: 'default', tone: 'neutral', words: 'Registrar default' }
  }
  if (preset.autoHiddenAt) {
    return { key: 'auto_hidden', tone: 'danger', words: 'Hidden by the checker' }
  }
  if (preset.isHidden) return { key: 'hidden', tone: 'neutral', words: 'Hidden by a person' }
  if (preset.checkFailedSince) {
    return {
      key: 'failing',
      tone: 'warning',
      words: `Failing since ${formatWat(preset.checkFailedSince)}`,
    }
  }
  if (preset.assignsPerZone) {
    return { key: 'per_zone', tone: 'neutral', words: 'Per domain — not checked' }
  }
  if (!preset.lastCheckedAt) return { key: 'unchecked', tone: 'info', words: 'Not checked yet' }
  return { key: 'ok', tone: 'ok', words: 'Answers in public DNS' }
}

/** For `?status=` on the list: failing in DNS, or hidden by anyone. */
export const isFailing = (preset: PresetRow) =>
  Boolean(preset.checkFailedSince || preset.autoHiddenAt)

const hostsPhrase = (count: number) =>
  count === 1 ? 'the host answers' : count === 2 ? 'both hosts answer' : `all ${count} hosts answer`

const listWords = (hosts: string[]) =>
  hosts.length <= 1
    ? (hosts[0] ?? '')
    : `${hosts.slice(0, -1).join(', ')} and ${hosts[hosts.length - 1]}`

/** "Checked at 14:05 WAT: both hosts answer." — from the gateway's on-demand answer. */
export function checkResultWords(result: AdminPresetDraftCheck): string {
  const at = `Checked at ${formatWatTime(result.checkedAt)}`
  if (result.ok) return `${at}: ${hostsPhrase(result.hosts.length)}.`
  const failed = result.hosts.filter((host) => !host.ok).map((host) => host.host)
  if (failed.length === 0) {
    return `${at}: the public resolvers didn't answer, so nothing was recorded. Try again in a minute.`
  }
  return `${at}: ${listWords(failed)} didn't answer. It can't be published until a check passes.`
}

/** What the draft's recorded check says: passing, failing, or not yet run. */
export function draftCheckWords(draft: DraftRow): { tone: Tone; words: string } {
  if (draft.assignsPerZone) {
    return {
      tone: 'neutral',
      words: 'Nothing to check: the host gives each domain its own nameservers.',
    }
  }
  if (!draft.checkedAt || draft.checkOk === null) {
    return {
      tone: 'info',
      words: 'Not checked yet. The gateway checks open drafts within 6 hours, or press Check now.',
    }
  }
  const at = `Checked ${formatWat(draft.checkedAt)}`
  if (draft.checkOk) {
    const count = draft.checkDetail?.hosts.length || draft.nameservers.length
    return { tone: 'ok', words: `${at}: ${hostsPhrase(count)}.` }
  }
  const failed = draft.checkDetail?.unresolved.length
    ? draft.checkDetail.unresolved
    : (draft.checkDetail?.hosts.filter((host) => host.verdict !== 'resolves') ?? []).map(
        (host) => host.host,
      )
  return {
    tone: 'warning',
    words: failed.length
      ? `${at}: ${listWords(failed)} didn't resolve. It can't be published until a check passes.`
      : `${at}: the check failed. It can't be published until a check passes.`,
  }
}

/** A draft can be published once a check passed after it was saved — or when there is nothing to check. */
export function canPublish(draft: DraftRow): boolean {
  if (!isOpen(draft)) return false
  if (draft.assignsPerZone) return true
  return (
    draft.checkOk === true &&
    draft.checkedAt !== null &&
    Date.parse(draft.checkedAt) > Date.parse(draft.savedAt)
  )
}

/** "Verified 23 Sept 2026" with its age said when it is past re-verification. */
export function verifiedWords(verifiedAt: string | null, now: Date): string {
  if (!verifiedAt) return 'Never verified'
  const date = formatWatDate(verifiedAt)
  return needsReverify(verifiedAt, now)
    ? `${date} — over ${REVERIFY_DAYS} days ago: check it against the provider's documentation`
    : date
}

/** "vercel.com" from a source URL, or the URL itself when it has no host. */
export function sourceHost(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

export type NameserverParse = { ok: true; hosts: string[] } | { ok: false; error: string }

/**
 * Nameservers as typed: one per line (commas and spaces work too), lower-cased,
 * a trailing dot dropped. 2 to 13 distinct hostnames — or none, for a host
 * that gives each domain its own (per-zone).
 */
export function parseNameservers(text: string, perZone: boolean): NameserverParse {
  const hosts = text
    .split(/[\s,]+/)
    .map((host) => host.trim().toLowerCase().replace(/\.$/, ''))
    .filter((host) => host !== '')
  if (perZone) {
    return hosts.length === 0
      ? { ok: true, hosts: [] }
      : {
          ok: false,
          error: 'A host that gives each domain its own nameservers has none here. Clear the list.',
        }
  }
  for (const host of hosts) {
    if (!nameserverSchema.safeParse(host).success) {
      return { ok: false, error: `${host} is not a hostname such as ns1.example.com.` }
    }
  }
  if (new Set(hosts).size !== hosts.length) {
    return { ok: false, error: 'A nameserver is listed twice. Remove the repeat.' }
  }
  if (hosts.length < 2 || hosts.length > 13) {
    return { ok: false, error: 'Give 2 to 13 nameservers, one per line.' }
  }
  return { ok: true, hosts }
}

/** A source URL the wrapper could accept: https, a host, and at most 500 characters. */
export function sourceUrlProblem(url: string): string | null {
  const trimmed = url.trim()
  if (!/^https:\/\/[A-Za-z0-9.-]+(?:[/?#]|$)/.test(trimmed) || trimmed.length > 500) {
    return "Paste the https address of the provider's own page that lists these nameservers."
  }
  return null
}

/** "2 linked, 2 active" lives in settings-copy; this is the tone beside it. */
export function pinnedTone(pinned: number, verified: number): Tone {
  if (verified === 0) return 'danger'
  return verified < pinned ? 'warning' : 'ok'
}
