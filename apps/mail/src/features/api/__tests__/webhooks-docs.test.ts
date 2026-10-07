import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  WEBHOOK_EVENTS,
  WEBHOOK_PORTS,
  WEBHOOK_TIMEOUT_SECONDS,
  WEBHOOK_USER_AGENT,
} from '@dr/shared/mail'
import { newWebhookSecret, signWebhook, verifyWebhook, webhookHeaders } from '@dr/shared/webhooks'
import { describe, expect, it } from 'vitest'
import {
  EXAMPLE_WEBHOOK_BODY,
  EXAMPLE_WEBHOOK_ID,
  EXAMPLE_WEBHOOK_PAYLOAD,
  EXAMPLE_WEBHOOK_SECRET,
  EXAMPLE_WEBHOOK_SIGNATURE,
  EXAMPLE_WEBHOOK_TIMESTAMP,
  exampleSignedContent,
  inJsonbOrder,
  NODE_IMPORTS,
  NODE_VERIFY_FUNCTION,
  nodeReceiverExample,
  rawWebhookRequest,
  WEBHOOK_EVENT_DOCS,
  WEBHOOK_EVENT_ORDER,
  WEBHOOK_PORT_WORDS,
} from '../docs/webhooks'

/**
 * The webhooks guide (MAIL-SPEC §6, MR6) against what the code does: the
 * worked example is what `@dr/shared/webhooks` signs, and the Node sample on
 * the page — this very text, run here — accepts what the worker sends and
 * refuses what it should, exactly as the shared verifier does.
 */

type Verify = (
  secret: string,
  headers: Record<string, string | undefined>,
  body: string,
  now?: number,
) => boolean

// The function as the page shows it; Node supplies the imports the page names.
const nodeVerify = new Function(
  'createHmac',
  'timingSafeEqual',
  'Buffer',
  `${NODE_VERIFY_FUNCTION}\nreturn verifyWebhook`,
)(createHmac, timingSafeEqual, Buffer) as Verify

const AT = Number(EXAMPLE_WEBHOOK_TIMESTAMP) * 1000
const exampleHeaders = {
  'webhook-id': EXAMPLE_WEBHOOK_ID,
  'webhook-timestamp': EXAMPLE_WEBHOOK_TIMESTAMP,
  'webhook-signature': EXAMPLE_WEBHOOK_SIGNATURE,
}

describe('the worked example', () => {
  it('is signed exactly as the worker signs (Standard Webhooks, HMAC-SHA256)', async () => {
    expect(
      await signWebhook(
        EXAMPLE_WEBHOOK_SECRET,
        EXAMPLE_WEBHOOK_ID,
        EXAMPLE_WEBHOOK_TIMESTAMP,
        EXAMPLE_WEBHOOK_BODY,
      ),
    ).toBe(EXAMPLE_WEBHOOK_SIGNATURE)
    expect(
      await verifyWebhook(
        EXAMPLE_WEBHOOK_SECRET,
        {
          id: EXAMPLE_WEBHOOK_ID,
          timestamp: EXAMPLE_WEBHOOK_TIMESTAMP,
          signature: EXAMPLE_WEBHOOK_SIGNATURE,
        },
        EXAMPLE_WEBHOOK_BODY,
        new Date(AT),
      ),
    ).toBe(true)
    expect(exampleSignedContent()).toBe(
      `${EXAMPLE_WEBHOOK_ID}.${EXAMPLE_WEBHOOK_TIMESTAMP}.${EXAMPLE_WEBHOOK_BODY}`,
    )
    expect(EXAMPLE_WEBHOOK_ID).toMatch(/^msg_[0-9a-f]{32}$/)
    expect(Buffer.from(EXAMPLE_WEBHOOK_SECRET.slice(6), 'base64').toString()).toBe(
      'MyDomainsHub example key',
    )
  })

  it('carries { type, created_at, data } in the order Postgres keeps jsonb keys, and no body (MR3)', () => {
    expect(Object.keys(EXAMPLE_WEBHOOK_PAYLOAD)).toEqual(['data', 'type', 'created_at'])
    expect(Object.keys(EXAMPLE_WEBHOOK_PAYLOAD.data as object)).toEqual([
      'to',
      'from',
      'tags',
      'subject',
      'email_id',
      'created_at',
    ])
    expect(EXAMPLE_WEBHOOK_BODY).not.toMatch(/"(html|text|attachments|body)"/)
    expect(EXAMPLE_WEBHOOK_BODY).toBe(JSON.stringify(EXAMPLE_WEBHOOK_PAYLOAD))
    expect(inJsonbOrder([{ bb: 1, a: [{ zz: 1, y: 2 }] }])).toEqual([
      { a: [{ y: 2, zz: 1 }], bb: 1 },
    ])
    expect(Object.keys(inJsonbOrder({ b: 1, a: 2, ab: 3 }) as object)).toEqual(['a', 'b', 'ab'])
    expect(inJsonbOrder(null)).toBeNull()
  })

  it('is shown on the wire as the worker sends it', () => {
    const raw = rawWebhookRequest()
    expect(raw).toContain(`webhook-id: ${EXAMPLE_WEBHOOK_ID}`)
    expect(raw).toContain(`webhook-signature: ${EXAMPLE_WEBHOOK_SIGNATURE}`)
    expect(raw).toContain(`user-agent: ${WEBHOOK_USER_AGENT}`)
    expect(raw).toContain('content-type: application/json')
    expect(raw).toContain(`content-length: ${Buffer.byteLength(EXAMPLE_WEBHOOK_BODY)}`)
    expect(raw.endsWith(`\n\n${EXAMPLE_WEBHOOK_BODY}`)).toBe(true)
  })
})

describe('the Node sample on the page', () => {
  it('accepts the worked example at its own moment, and refuses it five minutes on', () => {
    expect(nodeVerify(EXAMPLE_WEBHOOK_SECRET, exampleHeaders, EXAMPLE_WEBHOOK_BODY, AT)).toBe(true)
    expect(
      nodeVerify(EXAMPLE_WEBHOOK_SECRET, exampleHeaders, EXAMPLE_WEBHOOK_BODY, AT + 301_000),
    ).toBe(false)
    expect(
      nodeVerify(EXAMPLE_WEBHOOK_SECRET, exampleHeaders, EXAMPLE_WEBHOOK_BODY, AT - 301_000),
    ).toBe(false)
  })

  it('agrees with the shared verifier on what the worker sends, and on every way to get it wrong', async () => {
    const secret = newWebhookSecret()
    const now = new Date()
    const body = JSON.stringify(EXAMPLE_WEBHOOK_PAYLOAD)
    const signed = await webhookHeaders(secret, EXAMPLE_WEBHOOK_ID, body, now)
    const other = await webhookHeaders(newWebhookSecret(), EXAMPLE_WEBHOOK_ID, body, now)
    const cases: [string, Record<string, string | undefined>, string][] = [
      ['as sent', signed, body],
      ['a changed body', signed, body.replace('delivered', 'bounced')],
      ['the JSON made again with spaces', signed, JSON.stringify(EXAMPLE_WEBHOOK_PAYLOAD, null, 1)],
      ['another secret', other, body],
      [
        'two signatures, one right',
        {
          ...signed,
          'webhook-signature': `${other['webhook-signature']} ${signed['webhook-signature']}`,
        },
        body,
      ],
      [
        'another version',
        { ...signed, 'webhook-signature': signed['webhook-signature'].replace('v1,', 'v2,') },
        body,
      ],
      ['no signature', { ...signed, 'webhook-signature': undefined }, body],
      ['a timestamp that is not a number', { ...signed, 'webhook-timestamp': '12ab' }, body],
      ['another id', { ...signed, 'webhook-id': 'msg_00000000000000000000000000000000' }, body],
    ]
    for (const [what, headers, text] of cases) {
      const shared = await verifyWebhook(
        secret,
        {
          id: headers['webhook-id'] ?? null,
          timestamp: headers['webhook-timestamp'] ?? null,
          signature: headers['webhook-signature'] ?? null,
        },
        text,
        now,
      )
      expect(nodeVerify(secret, headers, text, now.getTime()), what).toBe(shared)
    }
    expect(nodeVerify(secret, signed, body, now.getTime())).toBe(true)
  })

  it('is the receiver the page shows, with its imports, reading the raw body and answering 2xx', () => {
    const code = nodeReceiverExample()
    expect(code.startsWith('// Node 18 or later')).toBe(true)
    expect(code).toContain(NODE_IMPORTS)
    expect(code).toContain(NODE_VERIFY_FUNCTION)
    expect(code).toContain('Buffer.concat(chunks)')
    expect(code).toContain('process.env.MDH_WEBHOOK_SECRET')
    expect(code).toContain(`within ${WEBHOOK_TIMEOUT_SECONDS} seconds`)
  })
})

describe('the events and the ports', () => {
  it('words every event the API sends, in its order, and nothing else', () => {
    expect(WEBHOOK_EVENT_ORDER).toEqual(WEBHOOK_EVENTS)
    expect(Object.keys(WEBHOOK_EVENT_DOCS).sort()).toEqual([...WEBHOOK_EVENTS].sort())
    expect(WEBHOOK_EVENT_DOCS['email.bounced'].extra).toContain('bounce.type')
    expect(WEBHOOK_EVENT_DOCS['email.failed'].extra).toContain('reason')
  })

  it('names the ports the worker calls', () => {
    expect(WEBHOOK_PORT_WORDS).toBe(WEBHOOK_PORTS.join(' or '))
    expect(WEBHOOK_PORT_WORDS).toBe('443 or 8443')
  })
})
