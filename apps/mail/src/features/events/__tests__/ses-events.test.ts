import { clearCertificateCache } from '@dr/shared/sns'
import { HttpResponse, http } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '../../../../tests/mocks/server'
import {
  SNS_CERT_URL,
  SNS_HOST,
  SNS_SUBSCRIBE_URL,
  SNS_TOPIC_ARN,
  sesEvent,
  snsConfirmation,
  snsNotification,
  snsPublicKeyPem,
  tenantStatusEvent,
} from '../../../../tests/mocks/sns'
import { mockRpc } from '../../../../tests/mocks/supabase'
import { handleSesEvents } from '../api/ses-events'
import { createEventStore } from '../api/store'

/**
 * POST /api/ses/events (MAIL-SPEC §4.2) against a stand-in SNS and the
 * PostgREST answers of migration 49: what reaches SQL, what each verdict
 * answers SNS with, and that no log line carries an address (N13, MR4).
 */

const { createClient } = await import('@supabase/supabase-js')
const client = createClient('http://127.0.0.1:54321', 'sb_test', {
  db: { schema: 'mail' },
  auth: { persistSession: false, autoRefreshToken: false },
})

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const MESSAGE_ID = '0102019a-mail-route-000000'
const ADDRESS = 'Ada.Obi@Example.com'

function deliver(body: unknown, topicArn: string | undefined = SNS_TOPIC_ARN) {
  return handleSesEvents(
    new Request('https://emails.mydomainshub.com/api/ses/events', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'text/plain; charset=UTF-8' },
    }),
    { topicArn, store: () => createEventStore(client as never), log },
  )
}

function serveCertificate(answer: () => Response = () => new HttpResponse(snsPublicKeyPem())) {
  const seen: string[] = []
  server.use(
    http.get(`https://${SNS_HOST}/:file`, ({ request }) => {
      seen.push(request.url)
      return answer()
    }),
  )
  return seen
}

const logged = () =>
  JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls])

beforeEach(() => {
  vi.clearAllMocks()
  clearCertificateCache()
})

describe('SES’s send events', () => {
  it('records a verified bounce with its codes, suppressions and the SNS id — and logs no address', async () => {
    serveCertificate()
    const calls = mockRpc({ record_send_event: () => true })
    const signed = snsNotification(
      sesEvent(
        'Bounce',
        MESSAGE_ID,
        {
          bounce: {
            bounceType: 'Permanent',
            bounceSubType: 'General',
            bouncedRecipients: [
              { emailAddress: ADDRESS, diagnosticCode: `smtp; 550 <${ADDRESS}> unknown` },
            ],
            timestamp: '2026-10-06T08:00:05.000Z',
          },
        },
        { to: ADDRESS },
      ),
    )
    const response = await deliver(signed)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.schema).toBe('mail')
    expect(calls[0]?.body).toEqual({
      p_event: 'bounce',
      p_message_id: MESSAGE_ID,
      p_email_public_id: '7d2f0c1e-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
      p_event_key: signed.MessageId,
      p_occurred_at: '2026-10-06T08:00:05.000Z',
      p_detail: {
        bounceType: 'Permanent',
        bounceSubType: 'General',
        diagnosticCode: `smtp; 550 <${ADDRESS}> unknown`,
      },
      p_recipients: 1,
      p_suppress: [ADDRESS],
    })
    expect(logged()).not.toMatch(/@/)
  })

  it('answers 200 to an event for no email of ours, and logs only ids', async () => {
    serveCertificate()
    mockRpc({ record_send_event: () => false })
    const response = await deliver(
      snsNotification(sesEvent('Delivery', MESSAGE_ID, { delivery: {} })),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, ignored: true })
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: MESSAGE_ID, known: false }),
      expect.stringContaining('no email of ours'),
    )
    expect(logged()).not.toMatch(/@/)
  })

  it('answers 503 when the database could not record it, so SNS delivers it again', async () => {
    serveCertificate()
    mockRpc({ record_send_event: () => ({ status: 500, body: { code: '57014', message: 'x' } }) })
    const response = await deliver(
      snsNotification(sesEvent('Delivery', MESSAGE_ID, { delivery: {} })),
    )
    expect(response.status).toBe(503)
    expect(log.error).toHaveBeenCalled()
  })

  it('ignores what is not an event it keeps, with 200', async () => {
    serveCertificate()
    const calls = mockRpc({})
    for (const message of [sesEvent('Open', MESSAGE_ID), 'not json', '[1,2]', '{"hello":1}']) {
      const response = await deliver(snsNotification(message))
      expect(await response.json()).toEqual({ ok: true, ignored: true })
    }
    expect(calls).toHaveLength(0)
  })
})

describe('tenant status and findings (EventBridge)', () => {
  it('records a pause by the tenant’s name, with no empty arguments', async () => {
    serveCertificate()
    const calls = mockRpc({
      record_tenant_event: () => ({ ok: true, known: true, applied: true, sesStatus: 'disabled' }),
    })
    const response = await deliver(snsNotification(tenantStatusEvent('DISABLED')))
    expect(response.status).toBe(200)
    expect(calls[0]?.body).toEqual({
      p_event_id: 'e5f2b1c0-1111-2222-3333-444455556666',
      p_type: 'sending_status',
      p_tenant: 'mdm-0a1b2c3d4e',
      p_resource_arn: 'arn:aws:ses:eu-west-2:123456789012:tenant/mdm-0a1b2c3d4e/tn-0a1b2c3d',
      p_occurred_at: '2026-10-06T08:00:00.995Z',
      p_status: 'DISABLED',
      p_origin: 'AWS_MANAGED',
      p_summary: 'Status updated by reputation policy.',
    })
  })

  it('answers 200 to a tenant that is not ours', async () => {
    serveCertificate()
    mockRpc({ record_tenant_event: () => ({ ok: true, known: false }) })
    const response = await deliver(
      snsNotification(tenantStatusEvent('ENABLED', { tenant: 'other' })),
    )
    expect(await response.json()).toEqual({ ok: true, ignored: true })
  })

  it('answers 503 when SQL refuses or answers something else', async () => {
    serveCertificate()
    mockRpc({ record_tenant_event: () => ({ status: 400, body: { code: '22023', message: 'x' } }) })
    expect((await deliver(snsNotification(tenantStatusEvent('ENABLED')))).status).toBe(503)
    mockRpc({ record_tenant_event: () => 'what' })
    expect((await deliver(snsNotification(tenantStatusEvent('ENABLED')))).status).toBe(503)
  })
})

describe('what is never acted on', () => {
  it.each([
    ['another topic', { TopicArn: 'arn:aws:sns:eu-west-2:123456789012:someone-else' }, 403],
    ['a certificate elsewhere', { SigningCertURL: 'https://attacker.example/x.pem' }, 403],
  ])('refuses a message for %s, before the database', async (_label, over, status) => {
    serveCertificate()
    const calls = mockRpc({ record_send_event: () => true })
    expect((await deliver(snsNotification(sesEvent('Delivery', MESSAGE_ID), over))).status).toBe(
      status,
    )
    expect(calls).toHaveLength(0)
  })

  it('refuses a forged signature, a body that is not JSON, or one too big', async () => {
    serveCertificate()
    const signed = snsNotification(sesEvent('Delivery', MESSAGE_ID))
    expect((await deliver({ ...signed, Message: '{"eventType":"Bounce"}' })).status).toBe(403)
    expect((await deliver('not json')).status).toBe(400)
    expect((await deliver({ Type: 'Notification' })).status).toBe(400)
    expect((await deliver('x'.repeat(300 * 1024 + 1))).status).toBe(413)
  })

  it('answers 503 while SNS’s certificate host is unreachable, or our topic is not set', async () => {
    serveCertificate(() => new HttpResponse(null, { status: 503 }))
    expect((await deliver(snsNotification(sesEvent('Delivery', MESSAGE_ID)))).status).toBe(503)
    expect(
      (await deliver(snsNotification(sesEvent('Delivery', MESSAGE_ID)), undefined)).status,
    ).toBe(503)
  })
})

describe('the subscription', () => {
  it('is confirmed by visiting SubscribeURL on the verified host', async () => {
    const seen = serveCertificate()
    let visited = ''
    server.use(
      http.get(`https://${SNS_HOST}/`, ({ request }) => {
        visited = request.url
        return HttpResponse.xml('<ConfirmSubscriptionResponse/>')
      }),
    )
    expect((await deliver(snsConfirmation())).status).toBe(200)
    expect(visited).toBe(SNS_SUBSCRIBE_URL)
    expect(seen).toEqual([SNS_CERT_URL])
  })

  it('is refused on any other host, and reported when SNS says no', async () => {
    serveCertificate()
    expect(
      (await deliver(snsConfirmation({ SubscribeURL: 'https://attacker.example/?Action=x' })))
        .status,
    ).toBe(400)
    server.use(http.get(`https://${SNS_HOST}/`, () => new HttpResponse(null, { status: 403 })))
    expect((await deliver(snsConfirmation())).status).toBe(502)
  })

  it('takes note of being unsubscribed', async () => {
    serveCertificate()
    expect((await deliver(snsConfirmation({ Type: 'UnsubscribeConfirmation' }))).status).toBe(200)
    expect(log.warn).toHaveBeenCalled()
  })
})
