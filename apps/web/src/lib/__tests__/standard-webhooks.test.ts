import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyWebhook } from '../standard-webhooks'

const RAW = Buffer.from('a-test-secret-of-thirty-two-bytes!!').toString('base64')
const SECRET = `v1,whsec_${RAW}`
const NOW = new Date('2026-09-24T12:00:00Z')
const TS = String(NOW.getTime() / 1000)
const BODY = '{"user":{"email":"ada@example.com"}}'

const sign = (body = BODY, id = 'msg_1', ts = TS, key = RAW) =>
  `v1,${createHmac('sha256', Buffer.from(key, 'base64')).update(`${id}.${ts}.${body}`).digest('base64')}`

const headers = (
  signature = sign(),
  over: Partial<Record<'id' | 'timestamp', string | null>> = {},
) => ({
  id: 'msg_1',
  timestamp: TS,
  signature,
  ...over,
})

describe('verifyWebhook (Standard Webhooks)', () => {
  it('accepts a body signed with the secret', () => {
    expect(verifyWebhook(SECRET, headers(), BODY, NOW)).toBe(true)
  })

  it('refuses a changed body, another secret, or another message id', () => {
    expect(verifyWebhook(SECRET, headers(), `${BODY} `, NOW)).toBe(false)
    const other = Buffer.from('another-secret-entirely-another!!').toString('base64')
    expect(verifyWebhook(SECRET, headers(sign(BODY, 'msg_1', TS, other)), BODY, NOW)).toBe(false)
    expect(verifyWebhook(SECRET, headers(sign(), { id: 'msg_2' }), BODY, NOW)).toBe(false)
  })

  it('refuses a request more than five minutes old or ahead, so it cannot be replayed', () => {
    const late = new Date(NOW.getTime() + 6 * 60_000)
    expect(verifyWebhook(SECRET, headers(), BODY, late)).toBe(false)
    const early = new Date(NOW.getTime() - 6 * 60_000)
    expect(verifyWebhook(SECRET, headers(), BODY, early)).toBe(false)
    expect(verifyWebhook(SECRET, headers(), BODY, new Date(NOW.getTime() + 4 * 60_000))).toBe(true)
  })

  it('accepts any one good signature among several, as when a secret rotates', () => {
    expect(verifyWebhook(SECRET, headers(`v1,bm9wZQ== ${sign()}`), BODY, NOW)).toBe(true)
  })

  it('refuses missing headers, a malformed timestamp, other versions and an empty key', () => {
    expect(verifyWebhook(SECRET, headers(sign(), { id: null }), BODY, NOW)).toBe(false)
    expect(verifyWebhook(SECRET, headers(sign(), { timestamp: 'soon' }), BODY, NOW)).toBe(false)
    expect(verifyWebhook(SECRET, headers(sign().replace('v1,', 'v2,')), BODY, NOW)).toBe(false)
    expect(verifyWebhook(SECRET, headers('v1'), BODY, NOW)).toBe(false)
    expect(verifyWebhook('v1,whsec_', headers(), BODY, NOW)).toBe(false)
    expect(verifyWebhook(SECRET, { id: 'msg_1', timestamp: TS, signature: null }, BODY, NOW)).toBe(
      false,
    )
  })
})
