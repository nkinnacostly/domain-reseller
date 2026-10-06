import 'server-only'

import { isWebhookEvent, type WebhookEvent } from '@dr/shared/mail'
import { createClient } from '@/lib/supabase/server'
import type { DeliveryStatus } from '../lib/words'

/**
 * The Webhooks page's reads (MAIL-SPEC §10), as the person: RLS lets an
 * account's members read its endpoints and deliveries (migration 49), and
 * the sealed secret is not granted to anyone. A failed read is null, so the
 * page shows its error state rather than "none yet" (S11).
 */

export type Webhook = {
  id: string
  url: string
  description: string | null
  events: WebhookEvent[]
  secretHint: string
  status: 'enabled' | 'disabled'
  disabledReason: 'customer' | 'failing' | null
  disabledAt: string | null
  failingSince: string | null
  lastSuccessAt: string | null
  createdAt: string
}

export type HistoryEntry = {
  at: string
  status: number | null
  error: string | null
  ms: number | null
}

export type Delivery = {
  id: number
  webhookId: string
  messageId: string
  eventType: WebhookEvent
  payload: unknown
  status: DeliveryStatus
  statusReason: string | null
  attempts: number
  nextAttemptAt: string
  lastAttemptAt: string | null
  lastStatusCode: number | null
  lastError: string | null
  lastResponse: string | null
  lastDurationMs: number | null
  history: HistoryEntry[]
  resendOf: number | null
  createdAt: string
}

/** How many deliveries the page shows: the newest. */
export const DELIVERIES_SHOWN = 50

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const num = (value: unknown): number | null => (typeof value === 'number' ? value : null)
const STATUSES = new Set<DeliveryStatus>(['pending', 'delivering', 'delivered', 'failed'])

export function readWebhooks(rows: unknown): Webhook[] {
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row) => {
    const r = row as Record<string, unknown>
    if (typeof r.id !== 'string' || typeof r.url !== 'string') return []
    return [
      {
        id: r.id,
        url: r.url,
        description: str(r.description),
        events: Array.isArray(r.events) ? r.events.filter(isWebhookEvent) : [],
        secretHint: str(r.secret_hint) ?? 'whsec_',
        status: r.status === 'disabled' ? 'disabled' : 'enabled',
        disabledReason:
          r.disabled_reason === 'customer' || r.disabled_reason === 'failing'
            ? r.disabled_reason
            : null,
        disabledAt: str(r.disabled_at),
        failingSince: str(r.failing_since),
        lastSuccessAt: str(r.last_success_at),
        createdAt: String(r.created_at ?? ''),
      },
    ]
  })
}

function readHistory(value: unknown): HistoryEntry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const e = entry as Record<string, unknown>
    return typeof e?.at === 'string'
      ? [{ at: e.at, status: num(e.status), error: str(e.error), ms: num(e.ms) }]
      : []
  })
}

export function readDeliveries(rows: unknown): Delivery[] {
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row) => {
    const r = row as Record<string, unknown>
    if (
      typeof r.id !== 'number' ||
      typeof r.webhook_id !== 'string' ||
      !isWebhookEvent(r.event_type) ||
      !STATUSES.has(r.status as DeliveryStatus)
    ) {
      return []
    }
    return [
      {
        id: r.id,
        webhookId: r.webhook_id,
        messageId: String(r.message_id ?? ''),
        eventType: r.event_type,
        payload: r.payload ?? null,
        status: r.status as DeliveryStatus,
        statusReason: str(r.status_reason),
        attempts: num(r.attempts) ?? 0,
        nextAttemptAt: String(r.next_attempt_at ?? ''),
        lastAttemptAt: str(r.last_attempt_at),
        lastStatusCode: num(r.last_status_code),
        lastError: str(r.last_error),
        lastResponse: str(r.last_response),
        lastDurationMs: num(r.last_duration_ms),
        history: readHistory(r.history),
        resendOf: num(r.resend_of),
        createdAt: String(r.created_at ?? ''),
      },
    ]
  })
}

export async function getWebhooks(accountId: string): Promise<Webhook[] | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('webhooks')
    .select(
      'id, url, description, events, secret_hint, status, disabled_reason, disabled_at, failing_since, last_success_at, created_at',
    )
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
  if (error) return null
  return readWebhooks(data)
}

export async function getDeliveries(
  accountId: string,
  webhookId?: string | null,
): Promise<Delivery[] | null> {
  const supabase = await createClient()
  let query = supabase
    .from('webhook_deliveries')
    .select(
      'id, webhook_id, message_id, event_type, payload, status, status_reason, attempts, next_attempt_at, last_attempt_at, last_status_code, last_error, last_response, last_duration_ms, history, resend_of, created_at',
    )
    .eq('account_id', accountId)
  if (webhookId) query = query.eq('webhook_id', webhookId)
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(DELIVERIES_SHOWN)
  if (error) return null
  return readDeliveries(data)
}
