import { WEBHOOK_EVENTS, type WebhookEvent, type WebhookUrlRefusal } from '@dr/shared/mail'
import type { Tone } from '@/components/common/status-pill'
import type { MemberRole } from '@/lib/safe-action'

/**
 * The Webhooks page in words (MAIL-SPEC §6, §10): what each event means,
 * each delivery's state and answer, and every refusal — what happened, why,
 * and what to do next. Nothing here claims more than the worker does: it
 * retries for 24 hours with backoff, and turns an endpoint off after three
 * days without a 2xx (migration 49).
 */

export const EVENT_WORDS: Record<WebhookEvent, { label: string; hint: string }> = {
  'email.sent': { label: 'Sent', hint: 'Amazon SES accepted the email for delivery.' },
  'email.delivered': { label: 'Delivered', hint: 'The recipient’s mail server took it.' },
  'email.delivery_delayed': {
    label: 'Delivery delayed',
    hint: 'A temporary problem; SES keeps trying.',
  },
  'email.bounced': { label: 'Bounced', hint: 'It could not be delivered.' },
  'email.complained': { label: 'Marked as spam', hint: 'A recipient reported it as spam.' },
  'email.failed': { label: 'Failed', hint: 'It was not sent: refused, or given up.' },
  'domain.verified': { label: 'Domain verified', hint: 'A domain is ready to send from.' },
  'domain.failed': { label: 'Domain failed', hint: 'A domain’s records were not found in time.' },
}

export const EVENT_GROUPS: { legend: string; events: WebhookEvent[] }[] = [
  { legend: 'Emails', events: WEBHOOK_EVENTS.filter((e) => e.startsWith('email.')) },
  { legend: 'Domains', events: WEBHOOK_EVENTS.filter((e) => e.startsWith('domain.')) },
]

/** Owners, admins and developers manage endpoints (SQL decides again); viewers read. */
export const canManageWebhooks = (role: MemberRole) => role !== 'viewer'

export const URL_REFUSAL: Record<WebhookUrlRefusal, string> = {
  not_url: 'Enter the full address of your endpoint, starting with https://',
  not_https: 'Use an https:// address: deliveries carry your customers’ addresses.',
  credentials:
    'Leave the user name and password out of the address; we sign every delivery instead.',
  too_long: 'That address is too long: keep it under 500 characters.',
  ip_v6: 'Use a host name rather than an IPv6 address.',
  private_address: 'That address is private or reserved. Use one the public internet can reach.',
  internal_name:
    'That name only works inside a network. Use a public host name, like hooks.example.com.',
  port: 'Use port 443 (the https default) or 8443: we call no other port.',
}

export type DeliveryStatus = 'pending' | 'delivering' | 'delivered' | 'failed'

export const DELIVERY_STATUS: Record<DeliveryStatus, { label: string; tone: Tone }> = {
  pending: { label: 'Waiting to retry', tone: 'warning' },
  delivering: { label: 'Sending', tone: 'info' },
  delivered: { label: 'Delivered', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
}

/** A delivery not tried yet: a new event, or a resend. */
export const DELIVERY_QUEUED = { label: 'Queued', tone: 'info' as Tone }

const ERROR_WORDS: Record<string, string> = {
  timeout: 'No answer within 10 seconds',
  connection_failed: 'Could not connect',
  dns_failed: 'The host name did not resolve',
  private_address: 'The host resolved to a private address, so we did not connect',
  port_not_allowed: 'The address uses a port we do not call; use 443 or 8443',
  tls_failed: 'The https certificate was not accepted',
  http_status: 'Answered with an error',
  no_answer: 'No answer',
  secret_unreadable: 'Our signing failed; rotate the endpoint’s secret',
  too_large: 'The answer was too large',
}

const REASON_WORDS: Record<string, string> = {
  gave_up: 'Gave up after 24 hours of retries',
  endpoint_disabled: 'The endpoint was turned off',
  secret_unreadable: 'Our signing failed; rotate the endpoint’s secret',
}

/** What the endpoint said, in a line: "200 in 120 ms", "No answer within 10 seconds". */
export function describeAnswer(delivery: {
  lastStatusCode: number | null
  lastError: string | null
  lastDurationMs: number | null
  attempts: number
}): string {
  if (delivery.attempts === 0) return 'Not tried yet'
  const took = delivery.lastDurationMs === null ? '' : ` in ${delivery.lastDurationMs} ms`
  if (delivery.lastStatusCode !== null) return `HTTP ${delivery.lastStatusCode}${took}`
  return ERROR_WORDS[delivery.lastError ?? ''] ?? 'No answer'
}

export function describeReason(reason: string | null): string | null {
  return reason ? (REASON_WORDS[reason] ?? null) : null
}

const SQL_WORDS: Record<string, string> = {
  unauthorized: 'Your session has ended. Sign in again to continue.',
  not_found: 'That endpoint was not found, or you are not a member of its account.',
  forbidden:
    'Your role in this account cannot manage webhooks. Ask its owner, an admin or a developer.',
  account_closed: 'This account is closed, so its webhooks cannot be changed.',
  webhook_disabled: 'That endpoint is turned off. Turn it back on to send to it again.',
  in_progress: 'That delivery is still being tried. Wait for its answer, then resend it.',
}

const FIELD_WORDS: Record<string, string> = {
  url: URL_REFUSAL.internal_name,
  events: 'Choose at least one event.',
  description: 'Keep the description under 100 characters.',
  secret: 'The signing secret could not be made. Nothing was saved; try again.',
}

export const WEBHOOK_FALLBACK = 'Something went wrong on our end. Nothing was changed. Try again.'

/** A webhook function's refusal (migration 49) in words. */
export function webhookRefusal(answer: { code?: unknown; field?: unknown; max?: unknown }): string {
  const code = typeof answer.code === 'string' ? answer.code : ''
  if (code === 'validation') return FIELD_WORDS[String(answer.field)] ?? WEBHOOK_FALLBACK
  if (code === 'webhook_limit') {
    return `This account has ${typeof answer.max === 'number' ? answer.max : 'the most'} endpoints, the most it can have. Delete one you no longer use first.`
  }
  return SQL_WORDS[code] ?? WEBHOOK_FALLBACK
}
