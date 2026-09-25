import { afterEach, describe, expect, it, vi } from 'vitest'

/** env.ts reads process.env at import, so each case loads it fresh. */
async function keyFor(
  headers: Record<string, string>,
  secret: string | undefined = 'sb_secret_test_only_dummy',
) {
  vi.resetModules()
  vi.stubEnv('SUPABASE_SECRET_KEY', secret)
  const { clientKey } = await import('../client-ip')
  return clientKey(new Headers(headers))
}

afterEach(() => vi.unstubAllEnvs())

describe('clientKey', () => {
  it('is a keyed hash, never the address itself', async () => {
    const key = await keyFor({ 'x-real-ip': '203.0.113.7' })
    expect(key).toMatch(/^[0-9a-f]{32}$/)
    expect(key).not.toContain('203')
  })

  it('tells people apart, and knows the same person again', async () => {
    const a = await keyFor({ 'x-real-ip': '203.0.113.7' })
    const b = await keyFor({ 'x-real-ip': '203.0.113.8' })
    expect(a).not.toBe(b)
    expect(await keyFor({ 'x-real-ip': '203.0.113.7' })).toBe(a)
  })

  it('takes the client from the front of x-forwarded-for when the platform sets no x-real-ip', async () => {
    expect(await keyFor({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })).toBe(
      await keyFor({ 'x-real-ip': '203.0.113.7' }),
    )
  })

  it('puts everyone it cannot tell apart in one bucket', async () => {
    expect(await keyFor({})).toBe(await keyFor({ 'x-forwarded-for': '' }))
  })

  it('still keys a count where no secret is configured', async () => {
    expect(await keyFor({ 'x-real-ip': '203.0.113.7' }, undefined)).toMatch(/^[0-9a-f]{32}$/)
  })

  it('hands the address itself only to whoever asks for it for this request', async () => {
    vi.resetModules()
    const { clientAddress } = await import('../client-ip')
    expect(clientAddress(new Headers({ 'x-real-ip': ' 203.0.113.7 ' }))).toBe('203.0.113.7')
    expect(clientAddress(new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe(
      '203.0.113.7',
    )
    expect(clientAddress(new Headers({ 'x-forwarded-for': '' }))).toBeUndefined()
    expect(clientAddress(new Headers())).toBeUndefined()
  })

  it('cannot be reproduced without the server’s secret', async () => {
    expect(await keyFor({ 'x-real-ip': '203.0.113.7' }, 'one-secret')).not.toBe(
      await keyFor({ 'x-real-ip': '203.0.113.7' }, 'another-secret'),
    )
  })
})
