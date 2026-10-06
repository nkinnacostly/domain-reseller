import 'server-only'

import {
  type Cursor,
  EMAIL_STATUSES,
  type EmailFilters,
  type EmailRow,
  emailRowSchema,
  SEND_EVENTS,
  toSqlFilters,
} from '@dr/shared/mail'
import { z } from 'zod'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'

/**
 * The email log and one email (MAIL-SPEC §10), read as the member:
 *
 *   the log    — `account_emails` (migration 48): the same page SQL gives
 *                the API, for any member of the account.
 *   one email  — the row, its events and, while it is kept (MR3: 72 hours
 *                after sending), its body: RLS shows bodies to owners,
 *                admins and developers only (migration 44).
 *
 * A read that fails is null, so the page shows its error state (S11).
 * Nothing here is logged but codes: these are people's emails (N13, MR4).
 */

export const LOG_PAGE = 25

const page = z.object({
  ok: z.literal(true),
  data: z.array(emailRowSchema),
  hasMore: z.boolean(),
  next: z.object({ at: z.string(), id: z.uuid() }).nullable(),
})

export type LogPage = { emails: EmailRow[]; next: Cursor | null }

export async function getEmailLog(
  accountId: string,
  filters: EmailFilters,
  cursor: Cursor | null,
): Promise<LogPage | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('account_emails', {
    p_account_id: accountId,
    p_filters: toSqlFilters(filters),
    p_limit: LOG_PAGE,
    ...(cursor ? { p_cursor_at: cursor.at, p_cursor_id: cursor.id } : {}),
  })
  const parsed = page.safeParse(data)
  if (error || !parsed.success) {
    logger.error({ err: error?.code ?? 'unexpected_answer' }, 'the email log could not be read')
    return null
  }
  return { emails: parsed.data.data, next: parsed.data.next }
}

const detailRow = z.object({
  id: z.number(),
  public_id: z.uuid(),
  from_address: z.string(),
  to_addresses: z.array(z.string()),
  cc_addresses: z.array(z.string()),
  bcc_addresses: z.array(z.string()),
  reply_to: z.array(z.string()),
  recipient_count: z.number().nullable(),
  subject: z.string(),
  tags: z.array(z.object({ name: z.string(), value: z.string() })).catch([]),
  status: z.enum(EMAIL_STATUSES),
  status_reason: z.string().nullable(),
  ses_message_id: z.string().nullable(),
  created_at: z.string(),
  scheduled_at: z.string(),
  sent_at: z.string().nullable(),
  delivered_at: z.string().nullable(),
  bounced_at: z.string().nullable(),
  complained_at: z.string().nullable(),
  failed_at: z.string().nullable(),
  canceled_at: z.string().nullable(),
})

export type EmailDetail = z.infer<typeof detailRow>

const eventRow = z.object({
  id: z.number(),
  type: z.enum(SEND_EVENTS),
  occurred_at: z.string(),
  detail: z.record(z.string(), z.unknown()).catch({}),
})

export type EmailEvent = z.infer<typeof eventRow>

const payloadRow = z.object({
  html: z.string().nullable(),
  text: z.string().nullable(),
  headers: z.record(z.string(), z.string()).catch({}),
})

export type EmailPayload = z.infer<typeof payloadRow>

export type EmailPage = {
  email: EmailDetail
  events: EmailEvent[]
  /** Null when deleted (MR3) or never kept — or when this role may not read bodies. */
  payload: EmailPayload | null
}

const DETAIL_COLUMNS =
  'id, public_id, from_address, to_addresses, cc_addresses, bcc_addresses, reply_to, recipient_count, subject, tags, status, status_reason, ses_message_id, created_at, scheduled_at, sent_at, delivered_at, bounced_at, complained_at, failed_at, canceled_at'

/** One email of this account, or 'missing' when there is none with that id. */
export async function getEmailPage(
  accountId: string,
  publicId: string,
): Promise<EmailPage | 'missing' | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('emails')
    .select(DETAIL_COLUMNS)
    .eq('account_id', accountId)
    .eq('public_id', publicId)
    .maybeSingle()
  if (error) {
    logger.error({ err: error.code }, 'an email could not be read')
    return null
  }
  if (!data) return 'missing'
  const email = detailRow.safeParse(data)
  if (!email.success) return null

  const [events, payload] = await Promise.all([
    supabase
      .from('email_events')
      .select('id, type, occurred_at, detail')
      .eq('email_id', email.data.id)
      .order('occurred_at', { ascending: true }),
    supabase
      .from('email_payloads')
      .select('html, text, headers')
      .eq('email_id', email.data.id)
      .maybeSingle(),
  ])
  if (events.error || payload.error) {
    logger.error(
      { err: events.error?.code ?? payload.error?.code },
      'an email’s parts could not be read',
    )
    return null
  }
  const parsedEvents = z.array(eventRow).safeParse(events.data ?? [])
  const parsedPayload = payload.data ? payloadRow.safeParse(payload.data) : null
  if (!parsedEvents.success || (parsedPayload && !parsedPayload.success)) return null
  return {
    email: email.data,
    events: parsedEvents.data,
    payload: parsedPayload?.success ? parsedPayload.data : null,
  }
}
