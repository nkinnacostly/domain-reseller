import { formatWatDate } from '@/features/admin/lib/format'
import type { Tone } from '@/features/admin/lib/tone'

/**
 * The alerts page's words (docs/ADMIN-SPEC.md §5.2, B5). Alerts are read,
 * never acted on here: each closes by itself when its condition goes, and
 * each links to the page where its cause is worked.
 */

export const ALERTS_TITLE = 'Alerts and health'
export const ALERTS_DESCRIPTION =
  'What needs a person, what the registry disagrees with, and whether the background services are running.'

export const OPEN_NOTE =
  'Alerts close by themselves once the condition is gone. There is no dismiss.'
export const TEST_SIDE_NOTE =
  'Test-side alerts are not re-evaluated by the running gateway; they may be out of date.'
export const DRIFT_NOTE = 'Drift closes when the next complete reconcile no longer finds it.'
/** §2.3: service_heartbeats has no side, so a test administrator is not shown it. */
export const HEARTBEATS_HIDDEN_TITLE = 'Not shown to test administrators'
export const HEARTBEATS_HIDDEN =
  'Service heartbeats have no side: they cover the live services as well as the sandbox.'

export const TAB_LABEL: Record<'open' | 'history' | 'drift' | 'health', string> = {
  open: 'Open',
  history: 'History',
  drift: 'Drift',
  health: 'Health',
}

/** What each kind of alert means, in a few words. An unknown kind shows as itself. */
export const ALERT_KIND_LABEL: Readonly<Record<string, string>> = {
  job_needs_attention: 'Job needs a person',
  ssl_job_needs_attention: 'Certificate job needs a person',
  ssl_status_unrecognised: 'Certificate status not recognised',
  order_stuck: 'Order stuck',
  refund_held: 'Refund held for approval',
  refund_needs_attention: 'Refund needs a person',
  refund_failed: 'Refund failed',
  refund_overdue: 'Refund overdue',
  refund_slow: 'Refund slow',
  payment_duplicate_charge: 'Charged twice',
  payment_overpayment: 'Overpaid',
  payment_underpayment: 'Underpaid',
  payment_empty_order: 'Paid for nothing to supply',
  reconcile_stale: 'Registry check overdue',
  float_low: 'Supplier balance low',
  float_low_cover: 'Supplier balance running out',
  catalogue_sync: 'Price list sync problem',
  compliance_notice_bounced: 'Renewal notice bounced',
  email_failed: 'Email failed',
  emails_waiting: 'Emails waiting to send',
  email_unconfirmed: 'Email delivery unconfirmed',
  email_complaint: 'Email marked as spam',
  preset_hidden: 'Host preset hidden',
  preset_failing: 'Host preset failing its check',
  preset_stale: 'Host preset not re-checked',
  supplier_unexplained_charge: 'Supplier charge with no order',
  supplier_double_charge: 'Supplier charged twice',
  supplier_charge_on_refunded_line: 'Supplier charge on a refunded line',
  supplier_missing_charge: 'Supplier charge missing',
  supplier_price_drift: 'Supplier price differs',
  supplier_ledger_unclassified: 'Supplier ledger entry not classified',
  supplier_ledger_changed: 'Supplier ledger entry changed',
  supplier_ledger_gap: 'Supplier ledger gap',
  supplier_ledger_stale: 'Supplier ledger not read',
  admin_changed: 'Admin access changed',
  admin_test_not_e2e: 'Test admin for a real account',
  admin_factor_missing: "Admin's authenticator gone",
  admin_burst: 'Many customer look-ups',
  admin_limit_raised: 'Refund limit raised',
  admin_preset_changed: 'Host preset changed',
  cron_stale: 'Scheduled job overdue',
  cron_failed: 'Scheduled job failed',
}

/** How the registry and our records disagree (`registry_drift.kind`). */
export const DRIFT_KIND_LABEL: Readonly<Record<string, string>> = {
  supplier_renewed: 'Renewed, not by us',
  expiry_moved_earlier: 'Expiry moved earlier',
  status_mismatch: 'Status differs',
  missing_at_registry: 'Missing at the registry',
  unknown_domain: 'Not in our records',
  registered_but_failed: 'Registered, but we failed it',
  supplier_may_renew: 'Registry may renew it',
}

const spaced = (value: string) => value.replace(/_/g, ' ')

/** Words for an alert kind; a drift alert names its drift. */
export function alertKindLabel(kind: string | null | undefined): string {
  if (!kind) return '—'
  const known = ALERT_KIND_LABEL[kind]
  if (known) return known
  if (kind.startsWith('drift_')) {
    const drift = kind.slice('drift_'.length)
    return `Registry drift: ${(DRIFT_KIND_LABEL[drift] ?? spaced(drift)).toLowerCase()}`
  }
  return spaced(kind)
}

export function driftKindLabel(kind: string | null | undefined): string {
  if (!kind) return '—'
  return DRIFT_KIND_LABEL[kind] ?? spaced(kind)
}

/** A value from a drift's `detail`: text the registry or we wrote, kept short. */
function text(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const trimmed = value.trim()
  return trimmed.length > 60 ? `${trimmed.slice(0, 59)}…` : trimmed
}

function expires(value: unknown): string | null {
  const day = typeof value === 'string' ? formatWatDate(value) : '—'
  return day === '—' ? null : `expires ${day}`
}

const join = (...parts: (string | null)[]) => {
  const kept = parts.filter((part): part is string => part !== null)
  return kept.length > 0 ? kept.join(', ') : '—'
}

const capital = (value: string) =>
  value === '—' ? value : value[0]?.toUpperCase() + value.slice(1)

/**
 * "Ours vs registry" from a drift's `detail`, as the reconcile writes it
 * (apps/gateway/src/reconcile/compare.ts). Unknown kinds or fields show a
 * dash rather than raw JSON.
 */
export function driftComparison(kind: string, detail: unknown): { ours: string; registry: string } {
  const d = (typeof detail === 'object' && detail !== null ? detail : {}) as Record<string, unknown>
  const status = (value: unknown) => {
    const word = text(value)
    return word ? `status ${spaced(word)}` : null
  }
  const renewal = (value: unknown) => {
    const word = text(value)
    return word ? `renewal mode ${word}` : null
  }
  switch (kind) {
    case 'supplier_renewed':
    case 'expiry_moved_earlier':
      return { ours: capital(join(expires(d.ours))), registry: capital(join(expires(d.registry))) }
    case 'status_mismatch':
      return {
        ours: capital(join(status(d.local_status))),
        registry: capital(join(status(d.registry_status))),
      }
    case 'missing_at_registry':
      return { ours: capital(join(status(d.local_status))), registry: 'No record' }
    case 'unknown_domain':
      return {
        ours: 'No record',
        registry: capital(
          join(status(d.registry_status), expires(d.expires_at), renewal(d.renewal_mode)),
        ),
      }
    case 'registered_but_failed':
      return {
        ours: 'Failed',
        registry: capital(join(status(d.registry_status), expires(d.expires_at))),
      }
    case 'supplier_may_renew':
      return {
        ours: capital(join('auto-renew off', expires(d.expires_at))),
        registry: capital(join(renewal(d.renewal_mode))),
      }
    default:
      return { ours: '—', registry: '—' }
  }
}

/** A background service's heartbeat name, `<service>:<target>`, in words. */
const SERVICE_LABEL: Readonly<Record<string, string>> = {
  gateway: 'Gateway',
  catalogue: 'Price list sync',
  ssl_catalogue: 'Certificate list sync',
  supplier_ledger: 'Supplier ledger sync',
}

const TARGET_LABEL: Readonly<Record<string, string>> = {
  production: 'live',
  ote: 'sandbox',
}

export function heartbeatLabel(name: string): string {
  const at = name.indexOf(':')
  const service = at < 0 ? name : name.slice(0, at)
  const target = at < 0 ? '' : name.slice(at + 1)
  const label = SERVICE_LABEL[service] ?? spaced(service)
  if (!target) return label
  return `${label} (${TARGET_LABEL[target] ?? target})`
}

/** The heartbeat that says the supplier ledger was read for a side. */
export function ledgerHeartbeatName(side: 'live' | 'test'): string {
  return `supplier_ledger:${side === 'test' ? 'ote' : 'production'}`
}

/** A heartbeat's outcome word, from its `detail.outcome`. */
export const OUTCOME_LABEL: Readonly<Record<string, string>> = {
  ok: 'OK',
  written: 'Written',
  unchanged: 'No changes',
  refused: 'Refused',
  failed: 'Failed',
}

export function outcomeTone(outcome: string | null): Tone {
  if (outcome === null) return 'neutral'
  if (outcome === 'failed') return 'danger'
  if (outcome === 'refused') return 'warning'
  if (outcome === 'ok' || outcome === 'written' || outcome === 'unchanged') return 'ok'
  return 'neutral'
}

/**
 * How a registry check ended. The error is the supplier's or ours, so only a
 * leading code (`API_301`) is shown, never its message (N10).
 */
export function runOutcome(run: { finishedAt: string | null; error: string | null }): {
  label: string
  tone: Tone
} {
  if (run.error !== null) {
    const code = /^([A-Za-z][A-Za-z0-9_]{1,39}):/.exec(run.error.trim())?.[1]
    return { label: code ? `Failed (${code})` : 'Failed', tone: 'danger' }
  }
  if (run.finishedAt === null) return { label: 'Running', tone: 'info' }
  return { label: 'Done', tone: 'ok' }
}

/** pg_cron's run states. */
export const CRON_STATUS_LABEL: Readonly<Record<string, string>> = {
  starting: 'Starting',
  running: 'Running',
  sending: 'Sending',
  connecting: 'Connecting',
  succeeded: 'Succeeded',
  failed: 'Failed',
}

export function cronTone(status: string | null): Tone {
  if (status === 'succeeded') return 'ok'
  if (status === 'failed') return 'danger'
  if (status === null) return 'neutral'
  return 'info'
}

/** "3.4 s" — a run's length. */
export function formatSeconds(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—'
  if (seconds < 10) return `${seconds.toFixed(1)} s`
  if (seconds < 120) return `${Math.round(seconds)} s`
  return `${Math.round(seconds / 60)} min`
}

/** "Sent 3 times" — how often Telegram was told. */
export function notifiedLabel(count: number): string {
  if (count <= 0) return 'Not sent'
  return count === 1 ? 'Once' : `${count} times`
}

/** The words of an alert's link, from where it goes. */
export function destinationLabel(href: string): string {
  const path = href.split(/[?#]/)[0] ?? href
  if (href.startsWith('/admin/alerts?tab=drift')) return 'Drift list'
  if (href.startsWith('/admin/alerts?tab=health')) return 'Health'
  if (path === '/admin/alerts') return 'Alerts'
  if (path.startsWith('/admin/queue/ssl-jobs')) return 'Certificate job'
  if (path.startsWith('/admin/queue/jobs')) return 'Job'
  if (path.startsWith('/admin/refunds/incidents')) return 'Incidents'
  if (path.startsWith('/admin/refunds')) return 'Refund'
  if (path.startsWith('/admin/orders/')) return 'Order'
  if (path.startsWith('/admin/orders')) return 'Orders'
  if (path.startsWith('/admin/ssl')) return 'Certificate'
  if (path.startsWith('/admin/supplier/catalogue')) return 'Price list'
  if (path.startsWith('/admin/supplier/ledger')) return 'Supplier ledger'
  if (path.startsWith('/admin/supplier')) return 'Supplier'
  if (path.startsWith('/admin/settings/presets')) return 'Host preset'
  if (path.startsWith('/admin/settings/admins')) return 'Admins'
  if (path.startsWith('/admin/emails')) return 'Emails'
  if (path.startsWith('/admin/audit')) return 'Audit log'
  return 'Open'
}
