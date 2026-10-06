/**
 * What SES says about a tenant, through EventBridge to the same SNS topic
 * (MAIL-SPEC §4.2): `Sending Status Enabled | Disabled` and `Advisor
 * Recommendation Status Open | Resolved`, as the SES developer guide's
 * tenants chapter shows them (read 6 Oct 2026). Read into what
 * `mail.record_tenant_event` (migration 49) takes; SQL finds the account by
 * the tenant (`mdm-…`) or, for a recommendation about an identity, by its
 * domain. EventBridge delivers on a best-effort basis, out of order: SQL
 * keeps the newest status and finds each finding's opening and resolution
 * in any order.
 */

export type TenantEventType = 'sending_status' | 'advisor_open' | 'advisor_resolved'

export type TenantEvent = {
  eventId: string
  type: TenantEventType
  /** The tenant's name, from its ARN (`…:tenant/<name>/<id>`). */
  tenant: string | null
  /** A domain identity's name, from its ARN (`…:identity/<domain>`). */
  identity: string | null
  resourceArn: string | null
  occurredAt: string | null
  /** sending_status: ENABLED, DISABLED or REINSTATED; and who changed it. */
  status: string | null
  origin: string | null
  /** advisor: SES's finding type (BOUNCE, COMPLAINT…), its impact, its words. */
  finding: string | null
  impact: string | null
  summary: string | null
}

const DETAIL_TYPES: Record<string, TenantEventType> = {
  'Sending Status Enabled': 'sending_status',
  'Sending Status Disabled': 'sending_status',
  'Advisor Recommendation Status Open': 'advisor_open',
  'Advisor Recommendation Status Resolved': 'advisor_resolved',
}

const STATUSES = new Set(['ENABLED', 'DISABLED', 'REINSTATED'])
const ARN = /^arn:aws:ses:[a-z0-9-]+:\d{12}:(tenant|identity)\/([^/\s]+)(\/[^\s]*)?$/
const NAME = /^[A-Za-z0-9_-]{1,64}$/
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/
const EVENT_ID = /^[A-Za-z0-9-]{1,200}$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, max) : null

/**
 * `lastUpdatedTimestamp` comes as `[2025, 7, 24, 12, 44, 28, 995000000]`
 * (year, month, day, hour, minute, second, nanoseconds; UTC).
 */
function fromParts(value: unknown): string | null {
  if (!Array.isArray(value) || value.length < 6) return null
  const parts = value.map((n) => (typeof n === 'number' && Number.isInteger(n) ? n : Number.NaN))
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0, nanos = 0] = parts
  if (parts.some(Number.isNaN) || month < 1 || month > 12 || day < 1 || day > 31) return null
  const at = new Date(Date.UTC(year, month - 1, day, hour, minute, second, Math.floor(nanos / 1e6)))
  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}

/** The SNS notification's `Message`, already parsed, as a tenant event — or null. */
export function parseTenantEvent(json: Record<string, unknown>): TenantEvent | null {
  if (json.source !== 'aws.ses') return null
  const detailType = json['detail-type']
  const type = typeof detailType === 'string' ? DETAIL_TYPES[detailType] : undefined
  const eventId = json.id
  if (!type || typeof eventId !== 'string' || !EVENT_ID.test(eventId)) return null

  const resources = Array.isArray(json.resources) ? json.resources : []
  const arn = typeof resources[0] === 'string' ? resources[0] : null
  const match = arn ? ARN.exec(arn) : null
  const kind = match?.[1]
  const name = match?.[2] ?? ''
  const tenant = kind === 'tenant' && NAME.test(name) ? name : null
  const identity =
    kind === 'identity' && DOMAIN.test(name.toLowerCase()) ? name.toLowerCase() : null

  const detail = asRecord(json.detail)
  const data = asRecord(detail.data)
  const record = asRecord(data.record)
  const metadata = asRecord(detail.metadata)
  const time = text(json.time, 40)
  const occurredAt =
    (type === 'sending_status' ? fromParts(record.lastUpdatedTimestamp) : null) ??
    (time && TIMESTAMP.test(time) ? time : null)

  const advisor = type !== 'sending_status'
  const status = advisor ? null : text(record.status, 20)
  // What SQL would refuse is not ours to retry: SNS would deliver it again forever.
  if (!advisor && !STATUSES.has(String(status).toUpperCase())) return null
  const sesType = text(metadata.type, 60)
  const finding = advisor && sesType && /[A-Za-z0-9]/.test(sesType) ? sesType : null
  const summary = advisor ? text(detail.data, 500) : text(record.cause, 500)
  if (advisor && !finding && !summary) return null

  return {
    eventId,
    type,
    tenant,
    identity,
    resourceArn: match && arn ? arn.slice(0, 300) : null,
    occurredAt,
    status,
    origin: advisor ? null : text(data.origin, 40),
    finding,
    impact: advisor ? text(metadata.impact, 10) : null,
    summary,
  }
}
