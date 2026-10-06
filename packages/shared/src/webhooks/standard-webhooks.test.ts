import { describe, expect, it } from 'vitest'
import {
  newWebhookSecret,
  signWebhook,
  verifyWebhook,
  webhookHeaders,
  webhookKey,
} from './standard-webhooks'

/**
 * The example in the Standard Webhooks specification, which its reference
 * libraries test against: a signer that agrees only with itself would pass a
 * round trip; this proves it agrees with everyone else's verifier.
 */
const VECTOR = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: '1614265330',
  body: '{"test": 2432232314}',
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
}
const AT_VECTOR = new Date(1614265330 * 1000)

const SECRET = 'v1,whsec_YS10ZXN0LXNlY3JldC1vZi10aGlydHktdHdvLWJ5dGVzISE='
const NOW = new Date('2026-09-24T12:00:00Z')
const TS = String(NOW.getTime() / 1000)
const BODY = '{"user":{"email":"ada@example.com"}}'

const headers = (
  signature: string | null,
  over: Partial<Record<'id' | 'timestamp', string | null>> = {},
) => ({
  id: 'msg_1',
  timestamp: TS,
  signature,
  ...over,
})

describe('Standard Webhooks against the specification’s example', () => {
  it('signs exactly as the reference libraries do', async () => {
    expect(await signWebhook(VECTOR.secret, VECTOR.id, VECTOR.timestamp, VECTOR.body)).toBe(
      VECTOR.signature,
    )
  })

  it('verifies the example', async () => {
    const given = { id: VECTOR.id, timestamp: VECTOR.timestamp, signature: VECTOR.signature }
    expect(await verifyWebhook(VECTOR.secret, given, VECTOR.body, AT_VECTOR)).toBe(true)
  })
})

describe('verifyWebhook (the shop’s Supabase hook and Mail’s customers, MR6)', () => {
  it('accepts a body signed with the secret, written with or without v1,', async () => {
    const signature = await signWebhook(SECRET, 'msg_1', TS, BODY)
    expect(await verifyWebhook(SECRET, headers(signature), BODY, NOW)).toBe(true)
    expect(await verifyWebhook(SECRET.slice(3), headers(signature), BODY, NOW)).toBe(true)
  })

  it('refuses a changed body, another secret, or another message id', async () => {
    const signature = await signWebhook(SECRET, 'msg_1', TS, BODY)
    expect(await verifyWebhook(SECRET, headers(signature), `${BODY} `, NOW)).toBe(false)
    const other = await signWebhook(
      'whsec_YW5vdGhlci1zZWNyZXQtZW50aXJlbHktYW5vdGhlciEh',
      'msg_1',
      TS,
      BODY,
    )
    expect(await verifyWebhook(SECRET, headers(other), BODY, NOW)).toBe(false)
    expect(await verifyWebhook(SECRET, headers(signature, { id: 'msg_2' }), BODY, NOW)).toBe(false)
  })

  it('refuses a request more than five minutes old or ahead, so it cannot be replayed', async () => {
    const signature = await signWebhook(SECRET, 'msg_1', TS, BODY)
    expect(
      await verifyWebhook(SECRET, headers(signature), BODY, new Date(NOW.getTime() + 6 * 60_000)),
    ).toBe(false)
    expect(
      await verifyWebhook(SECRET, headers(signature), BODY, new Date(NOW.getTime() - 6 * 60_000)),
    ).toBe(false)
    expect(
      await verifyWebhook(SECRET, headers(signature), BODY, new Date(NOW.getTime() + 4 * 60_000)),
    ).toBe(true)
  })

  it('accepts any one good signature among several, as when a secret rotates', async () => {
    const signature = await signWebhook(SECRET, 'msg_1', TS, BODY)
    expect(await verifyWebhook(SECRET, headers(`v1,bm9wZQ== ${signature}`), BODY, NOW)).toBe(true)
    expect(await verifyWebhook(SECRET, headers(`v1,not*base64 ${signature}`), BODY, NOW)).toBe(true)
  })

  it('refuses missing headers, a malformed timestamp, other versions and an empty key', async () => {
    const signature = await signWebhook(SECRET, 'msg_1', TS, BODY)
    expect(await verifyWebhook(SECRET, headers(signature, { id: null }), BODY, NOW)).toBe(false)
    expect(await verifyWebhook(SECRET, headers(signature, { timestamp: 'soon' }), BODY, NOW)).toBe(
      false,
    )
    expect(await verifyWebhook(SECRET, headers(signature.replace('v1,', 'v2,')), BODY, NOW)).toBe(
      false,
    )
    expect(await verifyWebhook(SECRET, headers('v1'), BODY, NOW)).toBe(false)
    expect(await verifyWebhook('v1,whsec_', headers(signature), BODY, NOW)).toBe(false)
    expect(await verifyWebhook(SECRET, headers(null), BODY, NOW)).toBe(false)
  })
})

describe('signing deliveries', () => {
  it('gives the three headers, timestamped in whole seconds', async () => {
    const sent = await webhookHeaders(SECRET, 'msg_9', BODY, new Date('2026-10-06T10:00:00.900Z'))
    expect(sent['webhook-id']).toBe('msg_9')
    expect(sent['webhook-timestamp']).toBe('1791280800')
    expect(
      await verifyWebhook(
        SECRET,
        { id: 'msg_9', timestamp: sent['webhook-timestamp'], signature: sent['webhook-signature'] },
        BODY,
        new Date('2026-10-06T10:00:01Z'),
      ),
    ).toBe(true)
  })

  it('refuses to sign with a secret that has no key', async () => {
    await expect(signWebhook('whsec_', 'msg_1', TS, BODY)).rejects.toThrow('no key')
    expect(webhookKey('whsec_!!')).toBeNull()
  })

  it('makes a new, random 24-byte secret each time', () => {
    const a = newWebhookSecret()
    expect(a).toMatch(/^whsec_[A-Za-z0-9+/]{32}$/)
    expect(webhookKey(a)?.length).toBe(24)
    expect(newWebhookSecret()).not.toBe(a)
  })
})
