import { describe, expect, it } from 'vitest'
import { parseEnv } from './env'

const BASE = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SECRET_KEY: 'sb_test',
  MAIL_API_KEY_PEPPER: 'test pepper, not a secret, 0123456789',
}

describe('the relay’s environment', () => {
  it('needs the database and the pepper, and defaults the rest', () => {
    expect(parseEnv(BASE)).toMatchObject({
      SMTP_PORT: 2525,
      SMTP_HOSTNAME: 'smtp.mydomainshub.com',
      SMTP_MAX_CLIENTS: 300,
      PORT: 8080,
      MAIL_SMTP_ID: expect.stringMatching(/^mail-smtp:/),
    })
  })

  it('refuses a short pepper or a missing secret key, and reads no AWS key at all', () => {
    expect(() => parseEnv({ ...BASE, MAIL_API_KEY_PEPPER: 'short' })).toThrow()
    const withoutSecret: Record<string, string | undefined> = { ...BASE }
    delete withoutSecret.SUPABASE_SECRET_KEY
    expect(() => parseEnv(withoutSecret)).toThrow()
    expect(Object.keys(parseEnv(BASE)).some((key) => /AWS|SES|ACCESS_KEY/.test(key))).toBe(false)
  })
})
