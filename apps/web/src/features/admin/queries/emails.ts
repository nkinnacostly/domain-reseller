import 'server-only'

import { z } from 'zod'
import { STATS_WINDOW_DAYS, UNCONFIRMED_HOURS } from '@/features/admin/lib/emails-copy'
import {
  type NoticeParams,
  type OutboxParams,
  watDayEnd,
  watDayStart,
} from '@/features/admin/lib/emails-params'
import type { KindStat, NoticeStat } from '@/features/admin/lib/emails-stats'
import { pageRange } from '@/features/admin/lib/list-params'
import type { AdminSide } from '@/features/admin/lib/side'
import { type AdminPrincipal, adminDb } from '@/features/admin/queries/session'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'

/**
 * The emails page's reads (docs/ADMIN-SPEC.md §5.2, B11). Rows come through
 * adminDb from the masked views — `admin_email_outbox_v` (`masked_to`,
 * `last_error_safe`) and `admin_compliance_notices_v` (`masked_recipient`)
 * — with the side applied for us; the figures from `admin_email_stats`,
 * called as the admin. Never an address, the template's data, a provider's
 * raw answer or its unmasked error: those stay in the database (N13).
 */

export type Failed = { ok: false }
const FAILED: Failed = { ok: false }

/** A read failed: its code goes to the log, never a row or an address (N13). */
function failed(what: string, error: { code?: string } | null): Failed {
  logger.warn({ code: error?.code ?? null }, `admin emails: ${what} could not be read`)
  return FAILED
}

export type Listed<Row> = { ok: true; rows: Row[]; total: number }

// ── Figures ───────────────────────────────────────────────────────────────

const count = z.coerce.number().int().nonnegative().catch(0)
const text = z.string().nullable().catch(null)

const statsSchema = z.object({
  byKind: z
    .array(
      z.object({
        kind: z.string(),
        category: z.string().catch(''),
        status: z.string(),
        deliveryStatus: text,
        count,
      }),
    )
    .catch([]),
  notices: z.array(z.object({ noticeType: z.string(), deliveryStatus: text, count })).catch([]),
})

export type EmailStats = { byKind: KindStat[]; notices: NoticeStat[]; days: number }

/** Counts for the last 30 days on one side; null when they could not be read. */
export async function getEmailStats(side: AdminSide): Promise<EmailStats | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('admin_email_stats', {
    p_test_mode: side === 'test',
    p_days: STATS_WINDOW_DAYS,
  })
  if (error) {
    failed('figures', error)
    return null
  }
  const parsed = statsSchema.safeParse(data)
  if (!parsed.success) {
    logger.warn(
      { issues: parsed.error.issues.length },
      'admin emails: figures had an unexpected shape',
    )
    return null
  }
  return { ...parsed.data, days: STATS_WINDOW_DAYS }
}

// ── The outbox ────────────────────────────────────────────────────────────

export type OutboxRow = {
  id: string
  testMode: boolean
  kind: string
  category: string
  status: string
  deliveryStatus: string | null
  attempts: number
  templateVersion: string | null
  createdAt: string
  sentAt: string | null
  nextAttemptAt: string | null
  complainedAt: string | null
  skipReason: string | null
  userId: string | null
  domainId: string | null
  orderId: string | null
  orderNumber: string | null
  /** `a•••@example.com`, masked in SQL; the address itself is never read. */
  maskedTo: string | null
  /** The last error with every address replaced by `[address]`. */
  lastErrorSafe: string | null
}

type OutboxViewRow = {
  id: string | null
  test_mode: boolean | null
  kind: string | null
  category: string | null
  status: string | null
  delivery_status: string | null
  attempts: number | null
  template_version: string | null
  created_at: string | null
  sent_at: string | null
  next_attempt_at: string | null
  complained_at: string | null
  skip_reason: string | null
  user_id: string | null
  domain_id: string | null
  order_id: string | null
  masked_to: string | null
  last_error_safe: string | null
}

const OUTBOX_SORT_COLUMN = { created: 'created_at', sent: 'sent_at' } as const

/** Order numbers for a page of emails, by order id; a failed read just leaves them out. */
async function orderNumbers(
  admin: AdminPrincipal,
  side: AdminSide,
  ids: (string | null)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  if (unique.length === 0) return new Map()
  const { data, error } = await adminDb(admin, side)
    .from('admin_orders_v')
    .select('id, order_number')
    .in('id', unique)
  if (error) {
    failed('order numbers', error)
    return new Map()
  }
  return new Map(
    (data ?? []).flatMap((row) =>
      row.id && row.order_number ? [[row.id, row.order_number] as const] : [],
    ),
  )
}

/** A page of the outbox on one side, filtered and sorted by the URL. */
export async function listOutbox(
  admin: AdminPrincipal,
  side: AdminSide,
  params: OutboxParams,
  now: Date = new Date(),
): Promise<Listed<OutboxRow> | Failed> {
  let query = adminDb(admin, side)
    .from('admin_email_outbox_v')
    .select(
      'id, test_mode, kind, category, status, delivery_status, attempts, template_version, created_at, sent_at, next_attempt_at, complained_at, skip_reason, user_id, domain_id, order_id, masked_to, last_error_safe',
      { count: 'exact' },
    )
  switch (params.status) {
    case null:
      break
    case 'bounced':
      query = query.eq('delivery_status', 'bounced')
      break
    case 'complained':
      query = query.not('complained_at', 'is', null)
      break
    case 'unconfirmed':
      // The `email_unconfirmed` alert's own test: a security or compliance
      // email sent a day ago with no final report is not counted delivered.
      query = query
        .eq('status', 'sent')
        .in('category', ['compliance', 'security'])
        .or('delivery_status.is.null,delivery_status.eq.deferred')
        .lt('sent_at', new Date(now.getTime() - UNCONFIRMED_HOURS * 3_600_000).toISOString())
      break
    default:
      query = query.eq('status', params.status)
  }
  if (params.category) query = query.eq('category', params.category)
  if (params.kind) query = query.eq('kind', params.kind)
  if (params.from) query = query.gte('created_at', watDayStart(params.from))
  if (params.to) query = query.lt('created_at', watDayEnd(params.to))
  const { from, to } = pageRange(params)
  const { data, error, count } = await query
    .order(OUTBOX_SORT_COLUMN[params.sort], {
      ascending: params.dir === 'asc',
      nullsFirst: false,
    })
    .order('id', { ascending: true })
    .range(from, to)
  if (error) return failed('outbox', error)

  const rows = ((data ?? []) as OutboxViewRow[]).filter(
    (row): row is OutboxViewRow & { id: string } => Boolean(row.id),
  )
  const numbers = await orderNumbers(
    admin,
    side,
    rows.map((row) => row.order_id),
  )
  return {
    ok: true,
    total: count ?? rows.length,
    rows: rows.map((row) => ({
      id: row.id,
      testMode: row.test_mode === true,
      kind: row.kind ?? '',
      category: row.category ?? '',
      status: row.status ?? '',
      deliveryStatus: row.delivery_status,
      attempts: row.attempts ?? 0,
      templateVersion: row.template_version,
      createdAt: row.created_at ?? '',
      sentAt: row.sent_at,
      nextAttemptAt: row.next_attempt_at,
      complainedAt: row.complained_at,
      skipReason: row.skip_reason,
      userId: row.user_id,
      domainId: row.domain_id,
      orderId: row.order_id,
      orderNumber: row.order_id ? (numbers.get(row.order_id) ?? null) : null,
      maskedTo: row.masked_to,
      lastErrorSafe: row.last_error_safe ? row.last_error_safe : null,
    })),
  }
}

// ── Compliance notices ────────────────────────────────────────────────────

export type NoticeRow = {
  id: string
  testMode: boolean
  domainId: string | null
  userId: string | null
  domainName: string
  noticeType: string
  expiresAt: string | null
  channel: string | null
  /** `a•••@example.com`, masked in SQL. */
  maskedRecipient: string | null
  templateVersion: string | null
  sentAt: string | null
  deliveryStatus: string | null
  checkedAt: string | null
}

type NoticeViewRow = {
  id: string | null
  test_mode: boolean | null
  domain_id: string | null
  user_id: string | null
  domain_name: string | null
  notice_type: string | null
  expires_at: string | null
  channel: string | null
  masked_recipient: string | null
  template_version: string | null
  sent_at: string | null
  delivery_status: string | null
  checked_at: string | null
}

const NOTICE_SORT_COLUMN = { sent: 'sent_at', expires: 'expires_at' } as const

/** A page of the ERRP notices sent on one side. Read only: they are compliance records. */
export async function listNotices(
  admin: AdminPrincipal,
  side: AdminSide,
  params: NoticeParams,
): Promise<Listed<NoticeRow> | Failed> {
  let query = adminDb(admin, side)
    .from('admin_compliance_notices_v')
    .select(
      'id, test_mode, domain_id, user_id, domain_name, notice_type, expires_at, channel, masked_recipient, template_version, sent_at, delivery_status, checked_at',
      { count: 'exact' },
    )
  if (params.status) query = query.eq('delivery_status', params.status)
  if (params.type) query = query.eq('notice_type', params.type)
  if (params.from) query = query.gte('sent_at', watDayStart(params.from))
  if (params.to) query = query.lt('sent_at', watDayEnd(params.to))
  const { from, to } = pageRange(params)
  const { data, error, count } = await query
    .order(NOTICE_SORT_COLUMN[params.sort], {
      ascending: params.dir === 'asc',
      nullsFirst: false,
    })
    .order('id', { ascending: true })
    .range(from, to)
  if (error) return failed('compliance notices', error)

  const rows = ((data ?? []) as NoticeViewRow[]).filter(
    (row): row is NoticeViewRow & { id: string } => Boolean(row.id),
  )
  return {
    ok: true,
    total: count ?? rows.length,
    rows: rows.map((row) => ({
      id: row.id,
      testMode: row.test_mode === true,
      domainId: row.domain_id,
      userId: row.user_id,
      domainName: row.domain_name ?? '',
      noticeType: row.notice_type ?? '',
      expiresAt: row.expires_at,
      channel: row.channel,
      maskedRecipient: row.masked_recipient,
      templateVersion: row.template_version,
      sentAt: row.sent_at,
      deliveryStatus: row.delivery_status,
      checkedAt: row.checked_at,
    })),
  }
}
