import 'server-only'

import { z } from 'zod'
import { bareAdminCode } from '@/features/admin/lib/errors'
import { ACCOUNT_STATES, type AccountState, type DomainStatus } from '@/features/admin/lib/states'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'

/**
 * Mail's admin reads (MAIL-SPEC §10, ADMIN-SPEC D4): each an `admin_mail_*`
 * SQL function behind the shop's gate, called as the admin with the session
 * client. A test admin is answered for e2e accounts only, and refused the
 * live SES account. Every answer is checked for its shape; a page meets a
 * refusal or a failure as a value, so it can say what happened (S11).
 */

export type Read<T> = { ok: true; data: T } | { ok: false; code: string }

const count = z.number().int().nonnegative()
const ppm = z.number().int().nullable()
const when = z.string().min(1)

const state = z.enum(ACCOUNT_STATES)

const overviewSchema = z.object({
  testOnly: z.boolean(),
  accounts: z.object({
    sandbox: count,
    active: count,
    paused: count,
    closed: count,
    sesPaused: count,
  }),
  reviewReady: count,
  findings: z.object({ pause: count, warning: count }),
  pendingTenantActions: count,
})
export type Overview = z.infer<typeof overviewSchema>

const reviewRowSchema = z.object({
  id: z.uuid(),
  shortId: z.string(),
  tenant: z.string(),
  name: z.string(),
  website: z.string().nullable(),
  useCase: z.string().nullable(),
  expectedMonthlyVolume: z.number().int().nullable(),
  planCode: z.string(),
  createdAt: when,
  sesStatus: z.string(),
  tenantReady: z.boolean(),
  ownerEmail: z.string().nullable(),
  verifiedDomains: count,
  pendingDomains: count,
  profileComplete: z.boolean(),
  ready: z.boolean(),
})
export type ReviewRow = z.infer<typeof reviewRowSchema>

const accountRowSchema = z.object({
  id: z.uuid(),
  shortId: z.string(),
  tenant: z.string(),
  name: z.string(),
  planCode: z.string(),
  state,
  stateReason: z.string().nullable(),
  sesStatus: z.string(),
  createdAt: when,
  caps: z.object({ daily: count, monthly: count }),
  today: count,
  month: count,
  openFindings: z.object({ pause: count, warning: count }),
})
export type AccountRow = z.infer<typeof accountRowSchema>

const page = <T extends z.ZodType>(row: T) => z.object({ rows: z.array(row), total: count })

const counters = z.object({
  queued: count,
  sent: count,
  delivered: count,
  bounced: count,
  complained: count,
  failed: count,
})

const windowSchema = z.object({
  days: z.number().int().positive(),
  sent: count,
  bounced: count,
  complained: count,
  bouncePpm: ppm,
  complaintPpm: ppm,
})
export type UsageWindow = z.infer<typeof windowSchema>

const findingSchema = z.object({
  id: z.number().int(),
  source: z.enum(['threshold', 'admin']),
  kind: z.string(),
  severity: z.enum(['warning', 'pause']),
  detail: z.record(z.string(), z.unknown()),
  openedAt: when,
  resolvedAt: when.nullable(),
  resolvedBy: z.string().nullable(),
  resolution: z.string().nullable(),
})
export type Finding = z.infer<typeof findingSchema>

const sesFindingSchema = z.object({
  id: z.number().int(),
  source: z.string(),
  kind: z.string(),
  impact: z.string().nullable(),
  summary: z.string().nullable(),
  openedAt: when,
  resolvedAt: when.nullable(),
})
export type SesFinding = z.infer<typeof sesFindingSchema>

const tenantActionSchema = z.object({
  id: z.number().int(),
  sendingStatus: z.enum(['DISABLED', 'ENABLED']),
  why: z.string(),
  state: z.enum(['pending', 'claimed', 'applied', 'canceled']),
  attempts: count,
  requestedBy: z.string(),
  requestedAt: when,
  appliedAt: when.nullable(),
  lastError: z.string().nullable(),
})
export type TenantAction = z.infer<typeof tenantActionSchema>

const accountSchema = z.object({
  id: z.uuid(),
  shortId: z.string(),
  tenant: z.string(),
  name: z.string(),
  website: z.string().nullable(),
  useCase: z.string().nullable(),
  expectedMonthlyVolume: z.number().int().nullable(),
  planCode: z.string(),
  planName: z.string().nullable(),
  state,
  stateReason: z.string().nullable(),
  prePauseState: z.string().nullable(),
  sesStatus: z.string(),
  tenantReadyAt: when.nullable(),
  isE2e: z.boolean(),
  createdAt: when,
  reviewedBy: z.string().nullable(),
  reviewedAt: when.nullable(),
  ownerEmail: z.string().nullable(),
  members: count,
  profileComplete: z.boolean(),
  caps: z.object({
    daily: count,
    monthly: count,
    planDaily: count.nullable(),
    planMonthly: count.nullable(),
    dailyOverride: count.nullable(),
    monthlyOverride: count.nullable(),
    warmupDay: count.nullable(),
    warmupCap: count.nullable(),
    sandboxDaily: count.nullable(),
  }),
  usage: z.object({ today: counters, month: counters }),
  window: windowSchema,
  window30: windowSchema,
  thresholds: z.object({
    bounceWarnPpm: z.number().int(),
    complaintWarnPpm: z.number().int(),
    bouncePausePpm: z.number().int(),
    complaintPausePpm: z.number().int(),
    minSends: z.number().int(),
    windowDays: z.number().int(),
  }),
  sesFindings: z.array(sesFindingSchema),
  findings: z.array(findingSchema),
  tenantActions: z.array(tenantActionSchema),
  domains: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      status: z.string(),
      verifiedAt: when.nullable(),
      lastCheckedAt: when.nullable(),
      createdAt: when,
    }),
  ),
  capNotices: z.array(
    z.object({
      scope: z.enum(['day', 'month']),
      periodStart: z.string(),
      level: z.union([z.literal(80), z.literal(100)]),
      cap: count,
      used: count,
      createdAt: when,
    }),
  ),
})
export type AccountDetail = z.infer<typeof accountSchema>

const domainRowSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: z.string(),
  accountId: z.uuid(),
  accountTenant: z.string(),
  accountName: z.string(),
  accountState: z.string(),
  verifiedAt: when.nullable(),
  lastCheckedAt: when.nullable(),
  createdAt: when,
  failedReason: z.string().nullable(),
})
export type DomainRow = z.infer<typeof domainRowSchema>

const numberOrNull = z.number().nullable().catch(null)

const healthSchema = z.object({
  quota: z
    .object({
      readAt: when,
      max24HourSend: numberOrNull,
      sentLast24Hours: numberOrNull,
      maxSendRate: numberOrNull,
      share: numberOrNull,
      holdFree: z.boolean().nullable().catch(null),
    })
    .nullable(),
  quotaAlertPct: z.number().int(),
  budget: z.object({ dailyBudget: count, reserved24h: count }),
  reputation: z.object({
    latest: z
      .object({
        readAt: when,
        metricAt: when.nullable(),
        bouncePpm: ppm,
        complaintPpm: ppm,
      })
      .nullable(),
    lastReadAt: when.nullable(),
    lastOutcome: z.string().nullable(),
    recent: z.array(
      z.object({ readAt: when, outcome: z.string(), bouncePpm: ppm, complaintPpm: ppm }),
    ),
    bounceWarnPpm: z.number().int(),
    complaintWarnPpm: z.number().int(),
    bouncePausePpm: z.number().int(),
    complaintPausePpm: z.number().int(),
  }),
  heartbeats: z.array(z.object({ name: z.string(), beatAt: when, silent: z.boolean() })),
  events: z.object({ lastReceivedAt: when.nullable(), sentLastHour: count }),
  pendingTenantActions: count,
})
export type SesHealth = z.infer<typeof healthSchema>

const auditRowSchema = z.object({
  id: z.number().int(),
  createdAt: when,
  adminLabel: z.string(),
  adminRole: z.string(),
  testActor: z.boolean(),
  action: z.string(),
  side: z.string().nullable(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  outcome: z.enum(['intent', 'ok', 'refused', 'failed']),
  errorCode: z.string().nullable(),
  reason: z.string().nullable(),
  redacted: z.boolean(),
  detail: z.record(z.string(), z.unknown()),
})
export type AuditRow = z.infer<typeof auditRowSchema>

type ReadFunction =
  | 'admin_mail_overview'
  | 'admin_mail_review_queue'
  | 'admin_mail_accounts'
  | 'admin_mail_account'
  | 'admin_mail_domains'
  | 'admin_mail_ses_health'
  | 'admin_mail_audit'

async function read<S extends z.ZodType>(
  fn: ReadFunction,
  args: Record<string, unknown>,
  schema: S,
): Promise<Read<z.output<S>>> {
  const supabase = await createClient()
  const { data, error } = await supabase.schema('public').rpc(fn as never, args as never)
  if (error) {
    const code = /^admin:[a-z_]+$/.test(error.message ?? '')
      ? bareAdminCode(error.message)
      : 'read_failed'
    if (code === 'read_failed')
      logger.error({ fn, code: error.code ?? null }, 'an admin read failed')
    return { ok: false, code }
  }
  const parsed = schema.safeParse(data)
  if (!parsed.success) {
    logger.error(
      { fn, issues: parsed.error.issues.length },
      'an admin read answered an unexpected shape',
    )
    return { ok: false, code: 'unexpected_answer' }
  }
  return { ok: true, data: parsed.data }
}

export const PAGE_SIZE = 50

export const getOverview = () => read('admin_mail_overview', {}, overviewSchema)

export const getReviewQueue = () => read('admin_mail_review_queue', {}, z.array(reviewRowSchema))

export const getAccounts = (filter: {
  state: AccountState | null
  query: string | null
  page: number
}) =>
  read(
    'admin_mail_accounts',
    {
      p_state: filter.state,
      p_query: filter.query,
      p_offset: (filter.page - 1) * PAGE_SIZE,
      p_limit: PAGE_SIZE,
    },
    page(accountRowSchema),
  )

/** One account, or null when there is none this admin may see. */
export const getAccount = (accountId: string) =>
  read('admin_mail_account', { p_account_id: accountId }, accountSchema.nullable())

export const getDomains = (filter: {
  status: DomainStatus | null
  query: string | null
  page: number
}) =>
  read(
    'admin_mail_domains',
    {
      p_status: filter.status,
      p_query: filter.query,
      p_offset: (filter.page - 1) * PAGE_SIZE,
      p_limit: PAGE_SIZE,
    },
    page(domainRowSchema),
  )

export const getSesHealth = () => read('admin_mail_ses_health', {}, healthSchema)

export const getAudit = (filter: { action: string | null; page: number }) =>
  read(
    'admin_mail_audit',
    { p_action: filter.action, p_offset: (filter.page - 1) * PAGE_SIZE, p_limit: PAGE_SIZE },
    page(auditRowSchema),
  )
