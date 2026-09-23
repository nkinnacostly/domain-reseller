import { describe, expect, it } from 'vitest'
import { parseEnv } from './env'

const BASE = {
  GATEWAY_SHARED_SECRET: 'test-secret-value-at-least-16',
  DNA_RESELLER_ID: '00000000-0000-0000-0000-000000000000',
  DNA_API_KEY: 'x',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SECRET_KEY: 'x',
}

describe('supplier write settings', () => {
  it('registers nothing unless asked to', () => {
    expect(parseEnv(BASE).DNA_WRITE_ENV).toBe('off')
  })

  it('needs the sandbox key to write to the sandbox', () => {
    expect(() => parseEnv({ ...BASE, DNA_WRITE_ENV: 'ote' })).toThrow(/sandbox key/)
    expect(
      parseEnv({ ...BASE, DNA_WRITE_ENV: 'ote', DNA_API_TEST_KEY: 'ote-key' }).DNA_WRITE_ENV,
    ).toBe('ote')
  })

  it.each(['development', 'test'])(
    'refuses live registrations with NODE_ENV=%s (N12)',
    (NODE_ENV) => {
      expect(() => parseEnv({ ...BASE, NODE_ENV, DNA_WRITE_ENV: 'production' })).toThrow(
        /NODE_ENV=production/,
      )
    },
  )

  it('allows them in a production deployment', () => {
    expect(
      parseEnv({ ...BASE, NODE_ENV: 'production', DNA_WRITE_ENV: 'production' }).DNA_WRITE_ENV,
    ).toBe('production')
  })
})
