/**
 * Where an ops alert is worked in the admin dashboard (docs/ADMIN-SPEC.md
 * §4.5), so a Telegram message can link straight to it. The key is
 * `<family>:<id>`, as current_alert_conditions builds it; the id is put in the
 * path or query only when it has the shape that family uses, so a malformed
 * key falls back to the alerts page rather than to an odd link.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DIGITS = /^\d{1,19}$/
const LABEL = /^[a-z][a-z0-9_-]{1,30}$/

const ALERTS = '/admin/alerts'

/**
 * MyDomainsHub Mail's admin (docs/MAIL-SPEC.md §10, §11): its alerts join
 * the shop's list on the live side (migration 51) but are worked on Mail's
 * own host, so their links are absolute. Every Mail key starts `mail_`.
 */
export const MAIL_ADMIN_URL = 'https://emails.mydomainshub.com/admin'

function mailAdminHref(family: string, id: string): string {
  switch (family) {
    case 'mail_tenant_paused':
    case 'mail_threshold_pause':
    case 'mail_threshold_warning':
      return UUID.test(id)
        ? `${MAIL_ADMIN_URL}/accounts/${id.toLowerCase()}`
        : `${MAIL_ADMIN_URL}/accounts`
    case 'mail_reputation':
    case 'mail_quota':
    case 'mail_silent':
    case 'mail_events_silent':
    case 'mail_tenant_action':
      return `${MAIL_ADMIN_URL}/health`
    default:
      return MAIL_ADMIN_URL
  }
}

function split(key: string): [string, string] {
  const at = key.indexOf(':')
  return at < 0 ? [key, ''] : [key.slice(0, at), key.slice(at + 1)]
}

const byUuid = (base: string, id: string) =>
  UUID.test(id) ? `${base}/${id.toLowerCase()}` : ALERTS

/** A path on the shop's admin — or, for a Mail alert, an absolute address on Mail's. */
export function adminHrefForAlertKey(key: string): string {
  const [family, id] = split(key)
  if (family.startsWith('mail_')) return mailAdminHref(family, id)
  switch (family) {
    case 'job':
      return byUuid('/admin/queue/jobs', id)
    case 'ssl_job':
      return byUuid('/admin/queue/ssl-jobs', id)
    case 'ssl_status':
      return byUuid('/admin/ssl', id)
    case 'order_stuck':
      return byUuid('/admin/orders', id)
    case 'refund':
    case 'refund_overdue':
    case 'refund_slow':
      return byUuid('/admin/refunds', id)
    case 'incident':
      // By its number, so the incident shows whether or not it is resolved.
      return DIGITS.test(id)
        ? `/admin/refunds/incidents?id=${id}#incident-${id}`
        : '/admin/refunds/incidents'
    case 'drift':
      return '/admin/alerts?tab=drift'
    case 'reconcile_stale':
    case 'cron_stale':
    case 'cron_failed':
      return '/admin/alerts?tab=health'
    case 'float_low':
    case 'float_cover':
      return '/admin/supplier'
    case 'catalogue_sync':
      return '/admin/supplier/catalogue'
    case 'preset_hidden':
    case 'preset_failing':
    case 'preset_stale':
      return byUuid('/admin/settings/presets', id)
    case 'email_failed':
      return '/admin/emails?status=failed'
    case 'email_unconfirmed':
      return '/admin/emails?status=unconfirmed'
    case 'email_complaint':
      return '/admin/emails?status=complained'
    case 'notice_bounced':
      return '/admin/emails?tab=compliance'
    case 'emails_waiting':
      return '/admin/emails?status=pending'
    case 'ledger_missing':
      return UUID.test(id) ? `/admin/orders?line=${id.toLowerCase()}` : '/admin/orders'
    case 'admin_changed':
    case 'admin_factor_missing':
    case 'admin_test_not_e2e':
      return '/admin/settings/admins'
    case 'admin_burst':
      // Keyed by the admin's label, not an audit row: the log filtered to that admin.
      return LABEL.test(id) ? `/admin/audit?admin=${id}` : '/admin/audit'
    case 'admin_limit_raised':
    case 'admin_preset_changed':
      return DIGITS.test(id) ? `/admin/audit?id=${id}` : '/admin/audit'
    default:
      if (family.startsWith('ledger_')) {
        return UUID.test(id)
          ? `/admin/supplier/ledger?trace=${id.toLowerCase()}`
          : '/admin/supplier/ledger'
      }
      return ALERTS
  }
}
