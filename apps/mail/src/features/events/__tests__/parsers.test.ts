import { describe, expect, it } from 'vitest'
import { advisorEvent, sesEvent, tenantStatusEvent } from '../../../../tests/mocks/sns'
import { parseSendEvent } from '../lib/ses-event'
import { parseTenantEvent } from '../lib/tenant-event'

/**
 * Reading SES's events (MAIL-SPEC §4.2): the seven configuration-set events
 * as SES's event publishing examples show them, and the tenant events
 * EventBridge sends, into what migration 49's functions take — codes and
 * words only, addresses only where they are needed to suppress.
 */

const ID = '0102019a-mail-event-000000'
const EMAIL = '7d2f0c1e-4a5b-4c6d-8e9f-0a1b2c3d4e5f'

describe('parseSendEvent', () => {
  it('reads a permanent bounce: its codes, the recipients SES names, our tag', () => {
    const event = parseSendEvent(
      sesEvent('Bounce', ID, {
        bounce: {
          bounceType: 'Permanent',
          bounceSubType: 'General',
          bouncedRecipients: [
            {
              emailAddress: 'Ada@Example.com',
              action: 'failed',
              status: '5.1.1',
              diagnosticCode: 'smtp; 550 5.1.1 <Ada@Example.com>: user unknown',
            },
            { emailAddress: 'bob@example.com', action: 'failed', status: '5.1.1' },
          ],
          timestamp: '2026-10-06T08:00:05.123Z',
          feedbackId: '0102-feedback',
          reportingMTA: 'dsn; mta.example.com',
        },
      }),
    )
    expect(event).toEqual({
      event: 'bounce',
      messageId: ID,
      emailId: EMAIL,
      occurredAt: '2026-10-06T08:00:05.123Z',
      detail: {
        bounceType: 'Permanent',
        bounceSubType: 'General',
        diagnosticCode: 'smtp; 550 5.1.1 <Ada@Example.com>: user unknown',
        status: '5.1.1',
        action: 'failed',
      },
      recipients: 2,
      suppress: ['Ada@Example.com', 'bob@example.com'],
    })
  })

  it('suppresses nobody for a transient bounce', () => {
    const event = parseSendEvent(
      sesEvent('Bounce', ID, {
        bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'a@example.com' }] },
      }),
    )
    expect(event?.suppress).toEqual([])
  })

  it('reads a complaint, a delivery, a delay, a send, a reject and a rendering failure', () => {
    expect(
      parseSendEvent(
        sesEvent('Complaint', ID, {
          complaint: {
            complainedRecipients: [{ emailAddress: 'ada@example.com' }, { emailAddress: 'nope' }],
            complaintFeedbackType: 'abuse',
            timestamp: '2026-10-06T09:00:00.000Z',
          },
        }),
      ),
    ).toMatchObject({
      event: 'complaint',
      detail: { complaintFeedbackType: 'abuse' },
      suppress: ['ada@example.com'],
      recipients: 2,
    })
    expect(
      parseSendEvent(
        sesEvent('Delivery', ID, {
          delivery: {
            timestamp: '2026-10-06T08:00:03.000Z',
            processingTimeMillis: 546,
            recipients: ['ada@example.com'],
            smtpResponse: '250 2.6.0 Message received',
          },
        }),
      ),
    ).toMatchObject({
      event: 'delivery',
      detail: { smtpResponse: '250 2.6.0 Message received' },
      suppress: [],
      recipients: 1,
      occurredAt: '2026-10-06T08:00:03.000Z',
    })
    expect(
      parseSendEvent(
        sesEvent('DeliveryDelay', ID, {
          deliveryDelay: {
            delayType: 'MailboxFull',
            delayedRecipients: [{ emailAddress: 'ada@example.com', status: '4.2.2' }],
            timestamp: '2026-10-06T08:10:00.000Z',
          },
        }),
      ),
    ).toMatchObject({
      event: 'delivery_delay',
      detail: { delayType: 'MailboxFull', status: '4.2.2' },
    })
    expect(parseSendEvent(sesEvent('Send', ID, { send: {} }))).toMatchObject({
      event: 'send',
      occurredAt: '2026-10-06T07:59:58.000Z',
      recipients: 1,
      detail: {},
    })
    expect(
      parseSendEvent(sesEvent('Reject', ID, { reject: { reason: 'Bad content' } })),
    ).toMatchObject({ event: 'reject', detail: { rejectReason: 'Bad content' } })
    expect(
      parseSendEvent(
        sesEvent('Rendering Failure', ID, {
          failure: { errorMessage: 'Attribute missing', templateName: 'T' },
        }),
      ),
    ).toMatchObject({ event: 'rendering_failure', detail: { errorMessage: 'Attribute missing' } })
  })

  it('reads an identity notification’s notificationType too', () => {
    const { eventType: _dropped, ...event } = sesEvent('Delivery', ID, { delivery: {} })
    expect(parseSendEvent({ ...event, notificationType: 'Delivery' })?.event).toBe('delivery')
  })

  it('finds no email id in a tag that is not one, and no time in one that is not a time', () => {
    const event = sesEvent('Send', ID, { send: {} }, { emailId: 'not-a-uuid' })
    const parsed = parseSendEvent({ ...event, mail: { ...event.mail, timestamp: 'yesterday' } })
    expect(parsed).toMatchObject({ emailId: null, occurredAt: null })
  })

  it('ignores opens, clicks, test messages and events with no usable message id', () => {
    expect(parseSendEvent(sesEvent('Open', ID))).toBeNull()
    expect(parseSendEvent(sesEvent('Click', ID))).toBeNull()
    expect(parseSendEvent({ hello: 'world' })).toBeNull()
    expect(parseSendEvent(sesEvent('Delivery', 'has spaces in it'))).toBeNull()
    expect(parseSendEvent({ eventType: 'Delivery', mail: [] })).toBeNull()
  })

  it('caps what it passes on: 50 recipients, 500 characters of a code', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ emailAddress: `r${i}@example.com` }))
    const event = parseSendEvent(
      sesEvent('Bounce', ID, {
        bounce: {
          bounceType: 'Permanent',
          bouncedRecipients: many,
          bounceSubType: 'x'.repeat(900),
        },
      }),
    )
    expect(event?.recipients).toBe(50)
    expect(event?.suppress).toHaveLength(50)
    expect(event?.detail.bounceSubType).toHaveLength(500)
  })
})

describe('parseTenantEvent', () => {
  it('reads a pause: the tenant, the status, who and when (lastUpdatedTimestamp)', () => {
    expect(parseTenantEvent(tenantStatusEvent('DISABLED'))).toEqual({
      eventId: 'e5f2b1c0-1111-2222-3333-444455556666',
      type: 'sending_status',
      tenant: 'mdm-0a1b2c3d4e',
      identity: null,
      resourceArn: 'arn:aws:ses:eu-west-2:123456789012:tenant/mdm-0a1b2c3d4e/tn-0a1b2c3d',
      occurredAt: '2026-10-06T08:00:00.995Z',
      status: 'DISABLED',
      origin: 'AWS_MANAGED',
      finding: null,
      impact: null,
      summary: 'Status updated by reputation policy.',
    })
  })

  it('falls back to the event’s time when the record has none it can read', () => {
    expect(
      parseTenantEvent(tenantStatusEvent('ENABLED', { at: [2026, 13, 1, 0, 0, 0] }))?.occurredAt,
    ).toBe('2026-10-06T08:00:01Z')
    expect(parseTenantEvent(tenantStatusEvent('REINSTATED', { at: [] }))?.status).toBe('REINSTATED')
  })

  it('reads a recommendation about a tenant, and one about an identity', () => {
    expect(parseTenantEvent(advisorEvent('Open'))).toMatchObject({
      type: 'advisor_open',
      tenant: 'mdm-0a1b2c3d4e',
      finding: 'BOUNCE',
      impact: 'HIGH',
      summary: 'The bounce rate exceeded 15.0% based on a representative volume of 197 emails.',
      status: null,
      origin: null,
    })
    expect(
      parseTenantEvent(
        advisorEvent('Resolved', {
          resource: 'arn:aws:ses:eu-west-2:123456789012:identity/Acme.Example',
          data: 'SPF record was not found.',
          metadata: {},
        }),
      ),
    ).toMatchObject({
      type: 'advisor_resolved',
      tenant: null,
      identity: 'acme.example',
      finding: null,
      summary: 'SPF record was not found.',
    })
  })

  it('reads no account from a resource that is not a tenant or a domain', () => {
    expect(
      parseTenantEvent(
        advisorEvent('Open', {
          resource: 'arn:aws:ses:eu-west-2:123456789012:identity/a@b.example',
        }),
      ),
    ).toMatchObject({ tenant: null, identity: null })
    expect(parseTenantEvent({ ...advisorEvent('Open'), resources: [] })).toMatchObject({
      tenant: null,
      identity: null,
      resourceArn: null,
    })
  })

  it('ignores what is not a tenant event, or what SQL could not record', () => {
    expect(parseTenantEvent({ ...tenantStatusEvent('ENABLED'), source: 'aws.s3' })).toBeNull()
    expect(
      parseTenantEvent({ ...tenantStatusEvent('ENABLED'), 'detail-type': 'Email Bounced' }),
    ).toBeNull()
    expect(parseTenantEvent({ ...tenantStatusEvent('ENABLED'), id: 'not an id!' })).toBeNull()
    const paused = tenantStatusEvent('ENABLED')
    paused.detail.data.record.status = 'PAUSED' as never
    expect(parseTenantEvent(paused)).toBeNull()
    expect(
      parseTenantEvent(advisorEvent('Open', { data: '', metadata: { type: '???' } })),
    ).toBeNull()
  })
})
