import { describe, expect, it } from 'vitest'
import { loopbackUrl, testEndpoints } from '../env'

/**
 * The e2e mocks' addresses (MAIL_SES_ENDPOINT, MAIL_DOH_URL,
 * MAIL_CLOUDFLARE_API_URL): on this machine only, and never on a production
 * deployment — a mock must not stand in for SES, a resolver or Cloudflare
 * where real customers are (MAIL-SPEC §12, N12 for email).
 */

describe('test endpoints', () => {
  it('are the real services when unset', () => {
    expect(testEndpoints({})).toEqual({ ses: null, doh: null, cloudflare: null })
    expect(
      testEndpoints({ MAIL_SES_ENDPOINT: '', MAIL_DOH_URL: '', MAIL_CLOUDFLARE_API_URL: '' }),
    ).toEqual({ ses: null, doh: null, cloudflare: null })
  })

  it('accept a mock on this machine outside production', () => {
    expect(
      testEndpoints({
        MAIL_SES_ENDPOINT: 'http://127.0.0.1:4312',
        MAIL_DOH_URL: 'http://localhost:4312/dns-query',
        VERCEL_ENV: 'preview',
      }),
    ).toEqual({
      ses: 'http://127.0.0.1:4312',
      doh: 'http://localhost:4312/dns-query',
      cloudflare: null,
    })
    expect(
      testEndpoints({ MAIL_CLOUDFLARE_API_URL: 'http://127.0.0.1:4312/client/v4' }).cloudflare,
    ).toBe('http://127.0.0.1:4312/client/v4')
    expect(testEndpoints({ MAIL_SES_ENDPOINT: 'http://[::1]:4312' }).ses).toBe('http://[::1]:4312')
  })

  it('are refused in production, even on this machine', () => {
    expect(() =>
      testEndpoints({ MAIL_SES_ENDPOINT: 'http://127.0.0.1:4312', VERCEL_ENV: 'production' }),
    ).toThrow('production refuses them')
    expect(() =>
      testEndpoints({ MAIL_DOH_URL: 'http://127.0.0.1:4312/dns-query', VERCEL_ENV: 'production' }),
    ).toThrow('production refuses them')
    expect(() =>
      testEndpoints({
        MAIL_CLOUDFLARE_API_URL: 'http://127.0.0.1:4312/client/v4',
        VERCEL_ENV: 'production',
      }),
    ).toThrow('production refuses them')
  })

  it('are refused anywhere but this machine', () => {
    expect(() => testEndpoints({ MAIL_SES_ENDPOINT: 'https://ses.example.com' })).toThrow(
      'on this machine',
    )
    expect(() => testEndpoints({ MAIL_DOH_URL: 'http://127.0.0.2.nip.io/dns-query' })).toThrow(
      'on this machine',
    )
    expect(() =>
      testEndpoints({ MAIL_CLOUDFLARE_API_URL: 'https://api.cloudflare.com/client/v4' }),
    ).toThrow('on this machine')
    expect(loopbackUrl.safeParse('ftp://localhost/x').success).toBe(false)
    expect(loopbackUrl.safeParse('not a url').success).toBe(false)
    expect(loopbackUrl.safeParse('https://localhost:4312').success).toBe(true)
  })
})
