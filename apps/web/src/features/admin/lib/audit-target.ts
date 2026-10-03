import { targetLabel } from '@/features/admin/lib/audit-copy'
import { maskEmailsIn } from '@/features/admin/lib/audit-detail'
import { shortId } from '@/features/admin/lib/format'
import { adminHref } from '@/features/admin/lib/href'

/**
 * Where an audit entry's target lives in the dashboard (docs/ADMIN-SPEC.md
 * §5.2 B14: "Target (linked)"). Links are built from ids only — a name
 * (a lookup's domain, an extension) is shown, never put in a URL (N13).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DIGITS = /^\d{1,19}$/

export type AuditTarget = { type: string | null; id: string | null }

/** The page that shows this target, or null when there is none to link by id. */
export function auditTargetHref({ type, id }: AuditTarget): string | null {
  if (!type) return null
  const uuid = id !== null && UUID.test(id)
  const digits = id !== null && DIGITS.test(id)
  switch (type) {
    case 'refund':
      return uuid ? adminHref.refund(id) : null
    case 'incident':
      return digits ? adminHref.incident(id) : null
    case 'job':
      return uuid ? adminHref.job(id) : null
    case 'ssl_job':
      return uuid ? adminHref.sslJob(id) : null
    case 'domain':
      return uuid ? adminHref.domain(id) : null
    case 'customer':
      return uuid ? adminHref.customer(id) : null
    case 'certificate':
      return uuid ? adminHref.certificate(id) : null
    case 'preset':
      return uuid ? adminHref.preset(id) : null
    case 'preset_draft':
      return '/admin/settings/presets?status=draft'
    case 'ledger':
      return uuid && id ? `/admin/supplier/ledger?trace=${id.toLowerCase()}` : null
    case 'audit':
      return digits ? adminHref.audit(id) : null
    case 'fx_rate':
      return '/admin/pricing/fx'
    case 'pricing_settings':
      return '/admin/pricing'
    case 'ops_settings':
      return '/admin/settings'
    default:
      return null
  }
}

/**
 * The target in words: "Refund 3f2a1b9c", "Domain example.com", "Supplier ·
 * test". An id is shortened; any email in it is masked, though no wrapper
 * names a target by one.
 */
export function auditTargetText({ type, id }: AuditTarget): string {
  const label = targetLabel(type)
  if (!id) return label
  if (UUID.test(id)) return `${label} ${shortId(id)}`
  if (type === 'supplier') return `${label} · ${maskEmailsIn(id)}`
  const text = maskEmailsIn(id)
  return `${label} ${text.length > 60 ? `${text.slice(0, 59)}…` : text}`
}
