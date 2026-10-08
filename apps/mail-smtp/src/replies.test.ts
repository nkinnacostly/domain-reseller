import { describe, expect, it } from 'vitest'
import { invalidReply, REPLIES, refusalReply, replyError } from './replies'

describe('SMTP replies', () => {
  it('maps each SQL refusal to final (5xx) or try-later (4xx), in the API’s words', () => {
    const code = (refusal: Parameters<typeof refusalReply>[0]) => refusalReply(refusal).code
    expect(code({ ok: false, code: 'unauthorized' })).toBe(535)
    expect(code({ ok: false, code: 'rate_limited', retryAfterMs: 1000 })).toBe(451)
    expect(code({ ok: false, code: 'budget_exceeded' })).toBe(451)
    expect(code({ ok: false, code: 'account_not_ready' })).toBe(451)
    expect(code({ ok: false, code: 'quota_exceeded', scope: 'day' })).toBe(451)
    expect(code({ ok: false, code: 'quota_exceeded', scope: 'month' })).toBe(550)
    for (const refused of [
      'forbidden',
      'sandbox_recipient',
      'domain_not_verified',
      'account_paused',
      'account_closed',
    ]) {
      expect(refusalReply({ ok: false, code: refused }).text).toMatch(/^5\.7\.1 /)
    }
    for (const refused of ['validation', 'idempotency_conflict', 'not_found']) {
      expect(refusalReply({ ok: false, code: refused }).text).toMatch(/^5\.6\.0 /)
    }
    expect(refusalReply({ ok: false, code: 'something new' })).toBe(REPLIES.internal)
  })

  it('keeps a reply to one line of at most 400 characters', () => {
    const reply = invalidReply(`one\r\ntwo ${'x'.repeat(500)}`)
    expect(reply.text).not.toMatch(/[\r\n]/)
    expect(reply.text.length).toBe(400)
  })

  it('hands smtp-server an error carrying the code', () => {
    expect(replyError(REPLIES.tooBig)).toMatchObject({
      responseCode: 552,
      message: REPLIES.tooBig.text,
    })
  })
})
