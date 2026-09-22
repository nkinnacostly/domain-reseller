import { describe, expect, it } from 'vitest'
import { authMessage, FALLBACK_MESSAGE } from '../lib/messages'

describe('authMessage', () => {
  it('never shows a raw provider error — unknown codes get a calm fallback', () => {
    expect(authMessage('some_new_supabase_code')).toBe(FALLBACK_MESSAGE)
    expect(authMessage(undefined)).toBe(FALLBACK_MESSAGE)
  })

  it('says a wrong password without saying which half was wrong', () => {
    const message = authMessage('invalid_credentials')
    expect(message).toMatch(/don't match/)
    expect(message).not.toMatch(/no account|not found|wrong password/i)
  })

  it('tells people what to do next, not just what failed', () => {
    expect(authMessage('email_not_confirmed')).toMatch(/open the link/i)
    expect(authMessage('mfa_verification_failed')).toMatch(/newest/)
    expect(authMessage('over_request_rate_limit')).toMatch(/wait/i)
  })
})
