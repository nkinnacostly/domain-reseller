import type { AdminRegistrantVerification, AdminRegistryDomain } from '@dr/shared/admin'
import { STATUS_LABEL } from '@/components/common/domain-status-pill'
import { ago, formatWatDate, formatWatTime } from '@/features/admin/lib/format'
import type { AdminSide } from '@/features/admin/lib/side'
import type { Tone } from '@/features/admin/lib/tone'
import { COUNTRY_NAMES } from '@/features/checkout/lib/countries'
import { type DelegationState, type DomainSource, LIVE_STATUSES } from './domains-params'

/**
 * The words on the domains pages (docs/ADMIN-SPEC.md §5.2, B9), and the
 * pure rules behind them: how our record is set beside the registry's, and
 * what a live read found. Nothing here is a raw supplier string (N10): the
 * registry's status and renewal mode are its own labels, shown as labels.
 */

export const DOMAINS_DESCRIPTION =
  'Every domain we hold on this side: its status, expiry, settings and what the registry last said.'

export const LIST_ERROR = "The domains couldn't be loaded."
export const STATS_ERROR = "The domain figures couldn't be loaded."
export const DETAIL_ERROR = "This domain couldn't be loaded."
export const SECTION_ERROR = "This part couldn't be loaded. Nothing was changed; try again."

export const SEARCH_HINT = 'A domain or part of one. Customers are found by email on Customers.'
export const SEARCH_NOT_EMAIL = 'Search by a domain here; find a customer by email on Customers.'
export const EMAIL_REFUSED =
  'Domains are searched by name here. An email address is never put in a link: find the customer on Customers, then their domains.'
export const UNKNOWN_SEARCH =
  'That isn’t a domain or part of one. Use letters, digits, dots and hyphens.'
export const NO_MATCH = 'No domains match these filters.'

export const sideWord = (side: AdminSide) => (side === 'test' ? 'Test' : 'Live')

export const NO_DOMAINS = (side: AdminSide) => `No domains on the ${sideWord(side)} side yet.`

export const SOURCE_LABEL: Readonly<Record<DomainSource, string>> = {
  registration: 'Registered here',
  transfer: 'Transferred in',
  demo: 'Demo',
}

export const DELEGATION_LABEL: Readonly<Record<DelegationState, string>> = {
  verified: 'Pointed and working',
  pending: 'Waiting to take effect',
  failed: 'Not working',
  undelegated: 'Not pointed at a host yet',
}

export const DELEGATION_TONE: Readonly<Record<DelegationState, Tone>> = {
  verified: 'ok',
  pending: 'info',
  failed: 'danger',
  undelegated: 'neutral',
}

/** A domain status in words, as the customer's panel names it. */
export function statusLabel(status: string | null | undefined): string {
  if (!status) return '—'
  return STATUS_LABEL[status as keyof typeof STATUS_LABEL] ?? status.replace(/_/g, ' ')
}

/** "On", "Off" — or the change waiting at the registry beside it. */
export function settingWords(current: boolean | null, pending: boolean | null = null): string {
  const now = current === null ? 'Not known' : current ? 'On' : 'Off'
  if (pending === null || pending === current) return now
  return `${now} — turning ${pending ? 'on' : 'off'}`
}

/** "in 160 days", "expired 3 days ago", or "no expiry yet". */
export function expiryWords(expiresAt: string | null, now: Date): string {
  if (!expiresAt) return 'No expiry yet'
  const when = Date.parse(expiresAt)
  if (Number.isNaN(when)) return 'No expiry yet'
  return when < now.getTime() ? `Expired ${ago(expiresAt, now)}` : `Expires ${ago(expiresAt, now)}`
}

// ── The registrant: a summary on the page, the rest only when revealed ─────

const REGISTRANT_TYPE_LABEL: Readonly<Record<string, string>> = {
  individual: 'Individual',
  organisation: 'Organisation',
}

/** The country's name and code, from the static map (never `Intl`, §15). */
export function countryWords(code: string | null | undefined): string {
  if (!code) return 'Not given'
  const upper = code.toUpperCase()
  const name = (COUNTRY_NAMES as Readonly<Record<string, string>>)[upper]
  return name ? `${name} (${upper})` : upper
}

export function registrantTypeWords(type: string | null | undefined): string {
  if (!type) return 'Not given'
  return REGISTRANT_TYPE_LABEL[type] ?? type
}

export const REVEAL = {
  trigger: 'Show registrant',
  title: (name: string) => `Show the registrant of ${name}?`,
  body: 'Your view is recorded in the audit log. The details stay on this page until you leave it.',
  confirm: 'Show registrant',
  done: 'Shown below. Your view is recorded in the audit log.',
  hide: 'Hide the details',
  hidden:
    'The full registrant and contacts are hidden. Showing them is recorded in the audit log and counts toward your hourly limit of look-ups.',
  none: 'No registrant is recorded for this domain.',
  roleOnly: 'Your admin role can see the summary, not the full registrant.',
} as const

export const CONTACT_ROLE_LABEL: Readonly<Record<string, string>> = {
  administrative: 'Administrative contact',
  technical: 'Technical contact',
  billing: 'Billing contact',
}

// ── Registry renewal mode (BACKLOG L18) ────────────────────────────────────

/**
 * The supplier's renewal-mode label, presented as a label and not as a risk:
 * automatic renewal isn't available to our account (§5.2 B9, BACKLOG L18).
 */
export function renewalModeWords(mode: string | null | undefined): string {
  const text = (mode ?? '').trim()
  if (text === '' || text === 'unknown') return 'Registry renewal mode not read yet'
  return `Registry renewal mode '${text.slice(0, 40)}' (the supplier's label; automatic renewal isn't available to our account, BACKLOG L18)`
}

// ── Ours beside the registry's ─────────────────────────────────────────────

export type Ours = {
  status: string | null
  expiresAt: string | null
  transferLock: boolean | null
  privacy: boolean | null
  nameservers: readonly string[] | null
}

export type ComparedRow = { label: string; ours: string; theirs: string; differs: boolean }

/** The statuses we hold a domain at the registry in: missing there, they differ. */
const HELD_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'expired_grace',
  'redemption',
  'pending_delete',
  'pending_verification',
])

/**
 * The reconcile's own rule (apps/gateway/src/reconcile/compare.ts): an active
 * domain differs when the registry's word is not active or ok. Other statuses
 * use words of their own at the registry, so they are not judged here.
 */
export function statusDiffers(local: string | null, registry: string | null): boolean {
  if (local !== 'active' || !registry) return false
  return !/^(active|ok)$/i.test(registry.trim())
}

const DAY_MS = 86_400_000

/** More than a day apart, as the reconcile tolerates (EXPIRY_TOLERANCE_MS). */
export function expiryDiffers(ours: string | null, theirs: string | null): boolean {
  if (!ours || !theirs) return false
  const a = Date.parse(ours)
  const b = Date.parse(theirs)
  if (Number.isNaN(a) || Number.isNaN(b)) return false
  return Math.abs(a - b) > DAY_MS
}

const nameserverSet = (values: readonly string[] | null | undefined) =>
  [...new Set((values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean))].sort()

export function nameserversDiffer(
  ours: readonly string[] | null,
  theirs: readonly string[] | null,
): boolean {
  const a = nameserverSet(ours)
  const b = nameserverSet(theirs)
  if (b.length === 0) return false
  return a.length !== b.length || a.some((value, index) => value !== b[index])
}

const flagDiffers = (ours: boolean | null, theirs: boolean | null) =>
  ours !== null && theirs !== null && ours !== theirs

export const nameserverWords = (values: readonly string[] | null | undefined) => {
  const set = nameserverSet(values)
  return set.length > 0 ? set.join(', ') : 'None'
}

/** The registry's status label, kept short: its own word, never an error text. */
export function registryStatusWords(word: string | null | undefined): string {
  const text = (word ?? '').trim()
  return text === '' ? 'Not read yet' : text.slice(0, 40).replace(/_/g, ' ')
}

/** What the hourly reconcile last stored: the registry's status only. */
export function storedComparison(
  ours: Ours,
  stored: { registryStatus: string | null; checkedAt: string | null },
): ComparedRow[] {
  return [
    {
      label: 'Status',
      ours: statusLabel(ours.status),
      theirs: registryStatusWords(stored.registryStatus),
      differs: statusDiffers(ours.status, stored.registryStatus),
    },
  ]
}

/** Our record beside one live registry read, field by field. */
export function liveComparison(ours: Ours, read: AdminRegistryDomain): ComparedRow[] {
  if (read.outcome === 'not_found') {
    return [
      {
        label: 'Status',
        ours: statusLabel(ours.status),
        theirs: 'Not in our account',
        differs: ours.status !== null && HELD_STATUSES.has(ours.status),
      },
    ]
  }
  const bool = (value: boolean | null) => (value === null ? 'Not read' : value ? 'On' : 'Off')
  return [
    {
      label: 'Status',
      ours: statusLabel(ours.status),
      theirs: registryStatusWords(read.status),
      differs: statusDiffers(ours.status, read.status),
    },
    {
      label: 'Expires',
      ours: formatWatDate(ours.expiresAt),
      theirs: formatWatDate(read.expiresAt),
      differs: expiryDiffers(ours.expiresAt, read.expiresAt),
    },
    {
      label: 'Transfer lock',
      ours: bool(ours.transferLock),
      theirs: bool(read.transferLock),
      differs: flagDiffers(ours.transferLock, read.transferLock),
    },
    {
      label: 'Privacy',
      ours: bool(ours.privacy),
      theirs: bool(read.privacy),
      differs: flagDiffers(ours.privacy, read.privacy),
    },
    {
      label: 'Nameservers',
      ours: nameserverWords(ours.nameservers),
      theirs: read.nameservers.length > 0 ? nameserverWords(read.nameservers) : 'Not read',
      differs: nameserversDiffer(ours.nameservers, read.nameservers),
    },
  ]
}

export const REGISTRY = {
  read: 'Read the registry now',
  storedCaption: (checkedAt: string | null) =>
    checkedAt
      ? `Our record beside what the hourly registry check stored, ${formatWatDate(checkedAt)} at ${formatWatTime(checkedAt)}`
      : 'Our record beside the registry: the hourly check has not read this domain yet',
  liveCaption: (readAt: string) =>
    `Our record beside the registry, read at ${formatWatTime(readAt)}`,
  hint: 'The page never asks the registry by itself. Reading it now is recorded in the audit log.',
  same: 'Our record matches the registry on every field read.',
  differs: (count: number) =>
    `${count} ${count === 1 ? 'field differs' : 'fields differ'}. The hourly check corrects our record from the registry; a deep sync reads this domain sooner.`,
  nothing: 'The registry answered nothing we could read.',
  lost: "The read didn't come back. Nothing was changed; try again.",
  roleOnly: 'Your admin role can see what the hourly check stored, not read the registry now.',
} as const

// ── Registrant verification (ICANN), read live ─────────────────────────────

export const VERIFICATION = {
  read: 'Read registrant verification',
  hint: 'Whether the registrant confirmed their email with the registry. Read on a click, never on its own; recorded in the audit log.',
  roleOnly: "Your admin role can't read the registrant's verification.",
} as const

/** A field kind the registry names ("Email"), shown only when it is a plain word. */
const FIELD_KIND = /^[A-Za-z][A-Za-z ]{0,19}$/

export function verificationWords(
  result: AdminRegistrantVerification | null,
  readAt?: string,
): string {
  if (!result) {
    return `${readAt ? `Read at ${formatWatTime(readAt)}: ` : ''}the registry lists no verification for this domain`
  }
  const at = `Read at ${formatWatTime(result.readAt)}`
  const kind = result.fieldType && FIELD_KIND.test(result.fieldType) ? ` (${result.fieldType})` : ''
  if (result.isVerified) {
    const on = result.verifiedAt ? ` on ${formatWatDate(result.verifiedAt)}` : ''
    return `${at}: verified${kind}${on}`
  }
  return `${at}: not verified yet${kind}`
}

// ── Queue a deep sync (§5.2 B9) ────────────────────────────────────────────

export const DEEP_SYNC = {
  trigger: 'Queue a deep sync',
  title: (name: string) => `Read ${name} from the registry on the next sync?`,
  body: 'The next deep sync, within an hour, reads it and corrects our record from the registry. Nothing changes at the registry.',
  confirm: 'Queue a deep sync',
  cancel: 'Not now',
  done: 'Queued: the next deep sync reads it within an hour.',
  waiting: 'Waiting for the next deep sync, within an hour.',
  last: (at: string) => `Last read by the deep sync ${formatWatDate(at)} at ${formatWatTime(at)}.`,
  demo: 'Demo domains were never at a registry, so nothing reads them.',
  notSyncable:
    'Only a live domain — active, expired or in redemption — is read again by the deep sync.',
  roleOnly: "Your admin role can't queue a deep sync.",
  /** §5.2 B9: shown on a test domain whenever the gateway:ote heartbeat is stale. */
  noGateway: (side: AdminSide) =>
    side === 'test'
      ? 'No sandbox gateway is reading test domains right now, so nothing would read it.'
      : 'No gateway is reading live domains right now, so nothing would read it.',
  /** service_heartbeats has no side, so a test administrator is not shown it (§2.3). */
  gatewayHidden:
    'Whether a gateway is reading this side is not shown to test administrators; the database checks it when you queue.',
} as const

/** How long a gateway's heartbeat stays fresh: `admin_queue_deep_sync`'s NO_GATEWAY rule. */
export const GATEWAY_FRESH_MS = 15 * 60 * 1000

export function gatewayStale(beatAt: string | null, now: Date): boolean {
  if (!beatAt) return true
  const at = Date.parse(beatAt)
  return Number.isNaN(at) || now.getTime() - at > GATEWAY_FRESH_MS
}

/** The heartbeat a deep sync on this side needs. */
export const gatewayHeartbeat = (side: AdminSide) =>
  side === 'test' ? 'gateway:ote' : 'gateway:production'

/** Whether the deep sync button is offered, and if not, why. */
export function deepSyncOffer(domain: {
  status: string | null
  source: string | null
}): { offered: true } | { offered: false; words: string } {
  if (domain.source === 'demo') return { offered: false, words: DEEP_SYNC.demo }
  if (!(LIVE_STATUSES as readonly (string | null)[]).includes(domain.status)) {
    return { offered: false, words: DEEP_SYNC.notSyncable }
  }
  return { offered: true }
}
