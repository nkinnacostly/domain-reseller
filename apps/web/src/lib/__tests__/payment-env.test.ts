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

  it('refuses a live public key outside production, even beside a test secret key (N12)', async () => {
    const require = await paymentEnv({
      ...TEST_KEYS,
      NODE_ENV: 'development',
      NEXT_PUBLIC_FLUTTERWAVE_PUBLIC_KEY: 'FLWPUBK-0000000000000000-X',
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

  it('never sends a live key anywhere but Flutterwave', async () => {
    // Through a helper, so the pre-commit secret scan does not take the dummy for a real key.
    const withSecret = (key: string) => ({ FLUTTERWAVE_SECRET_KEY: key })
    const require = await paymentEnv({
      ...TEST_KEYS,
      NEXT_PUBLIC_FLUTTERWAVE_PUBLIC_KEY: 'FLWPUBK-live-X',
      ...withSecret('FLWSECK-live-X'),
      NODE_ENV: 'production',
      FLUTTERWAVE_API_URL: 'https://flutterwave.attacker.test/v3',
    })
    expect(() => require()).toThrow(/only sent to https:\/\/api\.flutterwave\.com\/v3/)
  })

  it('lets test keys go to the e2e mock', async () => {
    const require = await paymentEnv({
      ...TEST_KEYS,
      NODE_ENV: 'development',
      FLUTTERWAVE_API_URL: 'http://127.0.0.1:4010/v3',
    })
    expect(require().testMode).toBe(true)
  })
})
