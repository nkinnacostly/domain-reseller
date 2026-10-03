import { adminHrefForAlertKey } from '@dr/shared/admin'

/**
 * Links between admin pages, built from ids — never from names, which would
 * put a customer's domain in a URL other admins share (N13). Every id is
 * checked for its shape first.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DIGITS = /^\d{1,19}$/

const byUuid = (base: string, id: string | null | undefined) =>
  id && UUID.test(id) ? `${base}/${id.toLowerCase()}` : base

/** A list narrowed to one id (`?user=`, `?line=`); a malformed id gives the whole list. */
const filteredBy = (base: string, param: string, id: string | null | undefined) =>
  id && UUID.test(id) ? `${base}?${param}=${id.toLowerCase()}` : base

export const adminHref = {
  overview: () => '/admin',
  order: (id: string | null | undefined) => byUuid('/admin/orders', id),
  refund: (id: string | null | undefined) => byUuid('/admin/refunds', id),
  /** One incident, resolved or not, scrolled to its card (§9: `?id=`). */
  incident: (id: number | string | null | undefined) =>
    id !== null && id !== undefined && DIGITS.test(String(id))
      ? `/admin/refunds/incidents?id=${id}#incident-${id}`
      : '/admin/refunds/incidents',
  job: (id: string | null | undefined) => byUuid('/admin/queue/jobs', id),
  sslJob: (id: string | null | undefined) => byUuid('/admin/queue/ssl-jobs', id),
  domain: (id: string | null | undefined) => byUuid('/admin/domains', id),
  customer: (id: string | null | undefined) => byUuid('/admin/customers', id),
  certificate: (id: string | null | undefined) => byUuid('/admin/ssl', id),
  /** The certificate bought on an order line (§9: `/admin/ssl?line=`). */
  certificateForLine: (orderItemId: string | null | undefined) =>
    filteredBy('/admin/ssl', 'line', orderItemId),
  /** One account's emails, by its id — never its address (§9: `/admin/emails?user=`). */
  customerEmails: (userId: string | null | undefined) =>
    filteredBy('/admin/emails', 'user', userId),
  preset: (id: string | null | undefined) => byUuid('/admin/settings/presets', id),
  audit: (id: number | string | null | undefined) =>
    id !== null && id !== undefined && DIGITS.test(String(id))
      ? `/admin/audit?id=${id}`
      : '/admin/audit',
  alert: (key: string) => adminHrefForAlertKey(key),
} as const
