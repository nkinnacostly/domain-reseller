import type { MailServiceClient } from '@/lib/supabase/service'
import type { MailSendEvent } from '../lib/ses-event'
import type { TenantEvent } from '../lib/tenant-event'

/**
 * The SNS endpoint's database boundary (migration 49), with the secret key,
 * whose only reach into schema `mail` here is `record_send_event` and
 * `record_tenant_event`. Both are idempotent: SNS delivers at least once.
 * A failure throws, so the endpoint answers 503 and SNS delivers again.
 */

export type EventStore = {
  /** Whether the email is one of ours. */
  recordSendEvent(event: MailSendEvent, eventKey: string): Promise<boolean>
  /** Whether the tenant (or identity) is one of ours, and whether anything changed. */
  recordTenantEvent(event: TenantEvent): Promise<{ known: boolean; applied: boolean }>
}

export class EventStoreError extends Error {
  constructor(
    readonly operation: string,
    readonly code: string | null,
  ) {
    super(`events: ${operation} failed${code ? ` (${code})` : ''}`)
    this.name = 'EventStoreError'
  }
}

export function createEventStore(client: MailServiceClient): EventStore {
  return {
    async recordSendEvent(event, eventKey) {
      const { data, error } = await client.rpc('record_send_event', {
        p_event: event.event,
        p_message_id: event.messageId,
        ...(event.emailId ? { p_email_public_id: event.emailId } : {}),
        p_event_key: eventKey,
        ...(event.occurredAt ? { p_occurred_at: event.occurredAt } : {}),
        p_detail: event.detail,
        p_recipients: event.recipients,
        p_suppress: event.suppress,
      })
      if (error) throw new EventStoreError('record_send_event', error.code ?? null)
      return data === true
    },

    async recordTenantEvent(event) {
      const optional = {
        p_tenant: event.tenant,
        p_identity: event.identity,
        p_resource_arn: event.resourceArn,
        p_occurred_at: event.occurredAt,
        p_status: event.status,
        p_origin: event.origin,
        p_finding: event.finding,
        p_impact: event.impact,
        p_summary: event.summary,
      }
      const { data, error } = await client.rpc('record_tenant_event', {
        p_event_id: event.eventId,
        p_type: event.type,
        ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== null)),
      })
      if (error) throw new EventStoreError('record_tenant_event', error.code ?? null)
      const answer = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
      if (answer.ok !== true) throw new EventStoreError('record_tenant_event', 'unexpected_answer')
      return { known: answer.known === true, applied: answer.applied === true }
    },
  }
}
