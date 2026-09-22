import { afterEach, describe, expect, it, vi } from 'vitest'

/** env.ts reads process.env once, at import — so each case imports it fresh. */
async function paymentEnv(vars: Record<string, string | undefined>) {
  vi.resetModules()
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value)
  const { requirePaymentEnv } = await import('../env')
  return requirePaymentEnv
}

const TEST_KEYS = {
  NEXT_PUBLIC_FLUTTERWAVE_PUBLIC_KEY: 'FLWPUBK_TEST-0000000000000000-X',
  FLUTTERWAVE_SECRET_KEY: 'FLWSECK_TEST-0000000000000000-X',
  FLUTTERWAVE_WEBHOOK_HASH: 'a-secret-hash',
}

afterEach(() => vi.unstubAllEnvs())

describe('requirePaymentEnv', () => {
  it('refuses live keys outside production (N12)', async () => {
    const require = await paymentEnv({
      ...TEST_KEYS,
      NODE_ENV: 'development',
      FLUTTERWAVE_SECRET_KEY: 'FLWSECK-0000000000000000-X',
    })
    expect(() => require()).toThrow(/Refusing live Flutterwave keys/)
  })

  it('says exactly what is missing', async () => {
    const require = await paymentEnv({ ...TEST_KEYS, FLUTTERWAVE_WEBHOOK_HASH: undefined })
    expect(() => require()).toThrow(/FLUTTERWAVE_WEBHOOK_HASH/)
  })

  it('hands back test keys in development', async () => {
    const require = await paymentEnv({ ...TEST_KEYS, NODE_ENV: 'development' })
    expect(require()).toEqual({
      secretKey: TEST_KEYS.FLUTTERWAVE_SECRET_KEY,
      publicKey: TEST_KEYS.NEXT_PUBLIC_FLUTTERWAVE_PUBLIC_KEY,
      webhookHash: TEST_KEYS.FLUTTERWAVE_WEBHOOK_HASH,
      testMode: true,
    })
  })

  it('accepts live keys in production', async () => {
    const require = await paymentEnv({
      NODE_ENV: 'production',
      NEXT_PUBLIC_FLUTTERWAVE_PUBLIC_KEY: 'FLWPUBK-live-X',
      FLUTTERWAVE_SECRET_KEY: 'FLWSECK-live-X',
      FLUTTERWAVE_WEBHOOK_HASH: 'a-secret-hash',
    })
    expect(require().secretKey).toBe('FLWSECK-live-X')
  })
})
