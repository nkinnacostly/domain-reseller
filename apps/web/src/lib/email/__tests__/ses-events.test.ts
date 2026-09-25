import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { env } from '@/lib/env'
import { server } from '../../../../tests/mocks/server'
import { sesEvent } from '../../../../tests/mocks/sns'
import { parseSesEvent, recordSesEvent } from '../ses-events'

const ID = '0102019a1b2c3d4e-5f6a7b8c-0000-4000-8000-000000000000-000000'
const parse = (eventType: string, extra: Record<string, unknown> = {}) =>
  parseSesEvent(JSON.stringify(sesEvent(eventType, ID, extra)))

describe('reading SES events (FR-NT3)', () => {
  it('reads a delivery', () => {
    expect(
      parse('Delivery', {
        delivery: {
          timestamp: '2026-09-25T08:00:00.000Z',
          recipients: ['ada@gmail.com'],
          smtpResponse: '250 ok ada@gmail.com',
        },
      }),
    ).toEqual({
      messageId: ID,
      event: 'delivery',
      detail: { at: '2026-09-25T08:00:00.000Z' },
    })
  })

  it.each(['Permanent', 'Transient', 'Undetermined'])(
    'reads a %s bounce with its type codes only',
    (bounceType) => {
      const event = parse('Bounce', {
        bounce: {
          bounceType,
          bounceSubType: 'General',
          timestamp: '2026-09-25T08:00:05.000Z',
          bouncedRecipients: [
            {
              emailAddress: 'ada@gmail.com',
              diagnosticCode: 'smtp; 550 5.1.1 <ada@gmail.com> no such user',
            },
          ],
        },
      })
      expect(event).toEqual({
        messageId: ID,
        event: 'bounce',
        detail: {
          bounce_type: bounceType,
          bounce_sub_type: 'General',
          at: '2026-09-25T08:00:05.000Z',
        },
      })
      expect(JSON.stringify(event)).not.toContain('ada@gmail.com')
    },
  )

  it('reads a complaint, a rejection, a delay and a rendering failure', () => {
    expect(
      parse('Complaint', {
        complaint: {
          complaintFeedbackType: 'abuse',
          complainedRecipients: [{ emailAddress: 'ada@gmail.com' }],
        },
      }),
    ).toMatchObject({
      event: 'complaint',
      detail: { complaint_type: 'abuse' },
    })
    expect(parse('Reject', { reject: { reason: 'Bad content' } })).toMatchObject({
      event: 'reject',
      detail: { reason: 'Bad content' },
    })
    expect(
      parse('DeliveryDelay', {
        deliveryDelay: {
          delayType: 'MailboxFull',
          delayedRecipients: [{ emailAddress: 'ada@gmail.com' }],
        },
      }),
    ).toMatchObject({
      event: 'delivery_delay',
      detail: { delay_type: 'MailboxFull' },
    })
    expect(
      parse('Rendering Failure', {
        failure: { errorMessage: 'Attribute name missing for ada', templateName: 't' },
      }),
    ).toEqual({
      messageId: ID,
      event: 'rendering_failure',
      detail: { at: '2026-09-25T07:59:58.000Z' },
    })
  })

  it('keeps codes, not free text', () => {
    expect(
      parse('Bounce', { bounce: { bounceType: 'Permanent', bounceSubType: 'x'.repeat(61) } })
        ?.detail,
    ).toEqual({
      bounce_type: 'Permanent',
      at: '2026-09-25T07:59:58.000Z',
    })
    expect(
      parse('Reject', { reject: { reason: 'Rejected <ada@gmail.com>' } })?.detail,
    ).not.toHaveProperty('reason')
  })

  it('reads the older notification shape too', () => {
    expect(
      parseSesEvent(JSON.stringify({ notificationType: 'Delivery', mail: { messageId: ID } })),
    ).toEqual({
      messageId: ID,
      event: 'delivery',
      detail: {},
    })
  })

  it.each([
    ['an SNS test message', 'hello'],
    ['an open', JSON.stringify(sesEvent('Open', ID))],
    ['a send', JSON.stringify(sesEvent('Send', ID))],
    ['no message id', JSON.stringify({ eventType: 'Delivery', mail: {} })],
    ['a strange message id', JSON.stringify({ eventType: 'Delivery', mail: { messageId: 'a b' } })],
    ['no event type', JSON.stringify({ mail: { messageId: ID } })],
    ['JSON that is not an object', '42'],
  ])('ignores %s', (_label, message) => {
    expect(parseSesEvent(message)).toBeNull()
  })
})

describe('recording SES events (migration 34)', () => {
  /** A made-up server key — only MSW ever sees it. */
  const SECRET = 'sb_secret_test_only'
  const settings = env as { SUPABASE_SECRET_KEY?: string }
  let before: string | undefined
  beforeEach(() => {
    before = settings.SUPABASE_SECRET_KEY
    settings.SUPABASE_SECRET_KEY = SECRET
  })
  afterEach(() => {
    settings.SUPABASE_SECRET_KEY = before
  })

  it('hands the message id, the event and its codes to record_email_event', async () => {
    let body: unknown
    server.use(
      http.post('*/rest/v1/rpc/record_email_event', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json(true)
      }),
    )
    const event = parse('Bounce', { bounce: { bounceType: 'Permanent', bounceSubType: 'General' } })
    if (!event) throw new Error('not parsed')
    expect(await recordSesEvent(event)).toBe(true)
    expect(body).toEqual({
      p_message_id: ID,
      p_event: 'bounce',
      p_detail: {
        bounce_type: 'Permanent',
        bounce_sub_type: 'General',
        at: '2026-09-25T07:59:58.000Z',
      },
    })
  })

  it('says when the message is not one of ours', async () => {
    server.use(http.post('*/rest/v1/rpc/record_email_event', () => HttpResponse.json(false)))
    const event = parse('Delivery')
    if (!event) throw new Error('not parsed')
    expect(await recordSesEvent(event)).toBe(false)
  })

  it('throws when the database could not record it, so SNS tries again', async () => {
    server.use(
      http.post('*/rest/v1/rpc/record_email_event', () =>
        HttpResponse.json({ message: 'connection refused', code: '08006' }, { status: 503 }),
      ),
    )
    const event = parse('Delivery')
    if (!event) throw new Error('not parsed')
    await expect(recordSesEvent(event)).rejects.toThrow()
  })
})
