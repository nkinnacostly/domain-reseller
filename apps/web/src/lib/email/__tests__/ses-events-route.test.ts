import { HttpResponse, http } from 'msw'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '@/lib/env'
import { server } from '../../../../tests/mocks/server'
import {
  SNS_HOST,
  SNS_SUBSCRIBE_URL,
  SNS_TOPIC_ARN,
  sesEvent,
  signSns,
  snsNotification,
} from '../../../../tests/mocks/sns'
import { clearCertificateCache } from '../sns'

vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }))

const { logger } = await import('@/lib/logger')
const { POST } = await import('@/app/api/email/ses-events/route')

const ID = '0102019a-route-test-000000'
/** A made-up server key — only MSW ever sees it. */
const SECRET = 'sb_secret_test_only'
const settings = env as { SES_EVENTS_TOPIC_ARN?: string; SUPABASE_SECRET_KEY?: string }
let before: typeof settings

beforeEach(() => {
  vi.clearAllMocks()
  clearCertificateCache()
  before = { ...settings }
  settings.SES_EVENTS_TOPIC_ARN = SNS_TOPIC_ARN
  settings.SUPABASE_SECRET_KEY = SECRET
})
afterEach(() => {
  settings.SES_EVENTS_TOPIC_ARN = before.SES_EVENTS_TOPIC_ARN
  settings.SUPABASE_SECRET_KEY = before.SUPABASE_SECRET_KEY
})

const deliver = (body: unknown) =>
  POST(
    new NextRequest('https://www.mydomainshub.com/api/email/ses-events', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: {
        'content-type': 'text/plain; charset=UTF-8',
        'x-amz-sns-message-type': 'Notification',
      },
    }),
  )

/** The database: records what it is given, knowing only message ID. */
function database(answer: () => Response = () => HttpResponse.json(true)) {
  const calls: unknown[] = []
  server.use(
    http.post('*/rest/v1/rpc/record_email_event', async ({ request }) => {
      calls.push(await request.json())
      return answer()
    }),
  )
  return calls
}

const logged = () =>
  JSON.stringify([
    vi.mocked(logger.info).mock.calls,
    vi.mocked(logger.warn).mock.calls,
    vi.mocked(logger.error).mock.calls,
  ])

describe('POST /api/email/ses-events (L1, FR-NT3)', () => {
  it('records a verified bounce and answers 200 — with no address in any log line', async () => {
    const calls = database()
    const response = await deliver(
      snsNotification(
        sesEvent('Bounce', ID, {
          bounce: {
            bounceType: 'Permanent',
            bounceSubType: 'NoEmail',
            timestamp: '2026-09-25T08:00:05.000Z',
            bouncedRecipients: [{ emailAddress: 'ada@gmail.com' }],
          },
        }),
      ),
    )
    expect(response.status).toBe(200)
    expect(calls).toEqual([
      {
        p_message_id: ID,
        p_event: 'bounce',
        p_detail: {
          bounce_type: 'Permanent',
          bounce_sub_type: 'NoEmail',
          at: '2026-09-25T08:00:05.000Z',
        },
      },
    ])
    expect(logged()).not.toContain('ada@gmail.com')
    expect(logged()).not.toContain('expires in 30 days')
  })

  it('records the same event again harmlessly when SNS repeats it', async () => {
    const calls = database()
    const message = snsNotification(sesEvent('Delivery', ID))
    expect((await deliver(message)).status).toBe(200)
    expect((await deliver(message)).status).toBe(200)
    expect(calls).toHaveLength(2)
  })

  it('answers 200 for an email that is not ours — SNS need not send it again', async () => {
    database(() => HttpResponse.json(false))
    const response = await deliver(snsNotification(sesEvent('Delivery', ID)))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, ignored: true })
  })

  it('answers 200 and records nothing for an event we do not keep', async () => {
    const calls = database()
    expect((await deliver(snsNotification(sesEvent('Open', ID)))).status).toBe(200)
    expect((await deliver(snsNotification('Successfully validated SNS topic'))).status).toBe(200)
    expect(calls).toEqual([])
  })

  it('answers 503 when the database could not record it, so SNS delivers it again', async () => {
    database(() => HttpResponse.json({ message: 'timeout' }, { status: 504 }))
    expect((await deliver(snsNotification(sesEvent('Delivery', ID)))).status).toBe(503)
  })

  it('refuses a forged or altered message, and records nothing', async () => {
    const calls = database()
    const genuine = snsNotification(sesEvent('Delivery', ID))
    const altered = {
      ...genuine,
      Message: JSON.stringify(sesEvent('Bounce', ID, { bounce: { bounceType: 'Permanent' } })),
    }
    expect((await deliver(altered)).status).toBe(403)
    expect(
      (await deliver({ ...genuine, TopicArn: 'arn:aws:sns:eu-west-2:123456789012:other' })).status,
    ).toBe(403)
    expect(
      (
        await deliver({
          ...genuine,
          SigningCertURL: 'https://attacker.example/SimpleNotificationService-x.pem',
        })
      ).status,
    ).toBe(403)
    expect((await deliver('not json')).status).toBe(400)
    expect((await deliver({ Type: 'Notification' })).status).toBe(400)
    expect(calls).toEqual([])
  })

  it('answers 503 when SNS’s certificate host cannot be reached — the message may be real', async () => {
    database()
    server.use(http.get(`https://${SNS_HOST}/:certificate`, () => HttpResponse.error()))
    expect((await deliver(snsNotification(sesEvent('Delivery', ID)))).status).toBe(503)
  })

  it('refuses an oversized body before reading it', async () => {
    expect((await deliver('x'.repeat(301 * 1024))).status).toBe(413)
  })

  it('cannot verify anything, and says so, when the topic is not configured', async () => {
    settings.SES_EVENTS_TOPIC_ARN = undefined
    expect((await deliver(snsNotification(sesEvent('Delivery', ID)))).status).toBe(503)
    expect(logger.error).toHaveBeenCalledWith(
      'SES_EVENTS_TOPIC_ARN is not set: SES delivery events cannot be verified',
    )
  })

  describe('the subscription', () => {
    const confirmation = (over: Record<string, string> = {}) =>
      signSns({
        Type: 'SubscriptionConfirmation',
        MessageId: '165545c9-2a5c-472c-8df2-7ff2be2b3b1b',
        Token: '2336412f37fb687f5d51e6e2425c464de',
        TopicArn: SNS_TOPIC_ARN,
        Message: 'You have chosen to subscribe to the topic.',
        SubscribeURL: SNS_SUBSCRIBE_URL,
        Timestamp: '2026-09-25T08:00:00.000Z',
        ...over,
      })

    it('is confirmed on SNS’s own host once the request is verified', async () => {
      let confirmed = false
      server.use(
        http.get(`https://${SNS_HOST}/`, () => {
          confirmed = true
          return HttpResponse.xml('<ConfirmSubscriptionResponse/>')
        }),
      )
      expect((await deliver(confirmation())).status).toBe(200)
      expect(confirmed).toBe(true)
    })

    it('is never confirmed on a host the message names', async () => {
      const response = await deliver(
        confirmation({ SubscribeURL: 'https://attacker.example/?Action=ConfirmSubscription' }),
      )
      expect(response.status).toBe(400)
    })

    it('reports a confirmation SNS refused, so it can be asked for again', async () => {
      server.use(http.get(`https://${SNS_HOST}/`, () => new HttpResponse(null, { status: 403 })))
      expect((await deliver(confirmation())).status).toBe(502)
    })

    it('notes an unsubscription and does nothing else', async () => {
      const calls = database()
      expect((await deliver(confirmation({ Type: 'UnsubscribeConfirmation' }))).status).toBe(200)
      expect(logger.warn).toHaveBeenCalledWith(
        'SES events: SNS reports this endpoint was unsubscribed',
      )
      expect(calls).toEqual([])
    })
  })
})
