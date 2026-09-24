import { describe, expect, it } from 'vitest'
import { parseEnv } from './env'

const BASE = {
  GATEWAY_SHARED_SECRET: 'test-secret-value-at-least-16',
  DNA_RESELLER_ID: '00000000-0000-0000-0000-000000000000',
  DNA_API_KEY: 'x',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SECRET_KEY: 'x',
}
const TEST_KEY = 'FLWSECK_TEST-0000000000000000-X'
const LIVE_KEY = 'FLWSECK-0000000000000000-X'
/** Dummy keys go through here so the pre-commit secret scan does not mistake them for real ones. */
const flw = (key: string) => ({ FLUTTERWAVE_SECRET_KEY: key })

describe('supplier write settings', () => {
  it('registers nothing unless asked to', () => {
    expect(parseEnv(BASE).DNA_WRITE_ENV).toBe('off')
  })

  it('needs the sandbox key to write to the sandbox', () => {
    expect(() => parseEnv({ ...BASE, ...flw(TEST_KEY), DNA_WRITE_ENV: 'ote' })).toThrow(
      /sandbox key/,
    )
    expect(
      parseEnv({ ...BASE, ...flw(TEST_KEY), DNA_WRITE_ENV: 'ote', DNA_API_TEST_KEY: 'ote-key' })
        .DNA_WRITE_ENV,
    ).toBe('ote')
  })

  it('registers only with a Flutterwave key to confirm each charge first (SEC-7)', () => {
    expect(() => parseEnv({ ...BASE, DNA_WRITE_ENV: 'ote', DNA_API_TEST_KEY: 'ote-key' })).toThrow(
      /set FLUTTERWAVE_SECRET_KEY/,
    )
    expect(() =>
      parseEnv({ ...BASE, NODE_ENV: 'production', DNA_WRITE_ENV: 'production' }),
    ).toThrow(/set FLUTTERWAVE_SECRET_KEY/)
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
      parseEnv({ ...BASE, ...flw(LIVE_KEY), NODE_ENV: 'production', DNA_WRITE_ENV: 'production' })
        .DNA_WRITE_ENV,
    ).toBe('production')
  })
})

describe('refund and alert settings', () => {
  const OTE = { ...BASE, DNA_WRITE_ENV: 'ote', DNA_API_TEST_KEY: 'ote-key' }
  const LIVE = { ...BASE, NODE_ENV: 'production', DNA_WRITE_ENV: 'production' }

  it('needs no key while nothing is registered', () => {
    expect(parseEnv(BASE).FLUTTERWAVE_SECRET_KEY).toBeUndefined()
  })

  it('refunds test payments with a test key on the sandbox side', () => {
    expect(parseEnv({ ...OTE, ...flw(TEST_KEY) }).FLUTTERWAVE_SECRET_KEY).toBe(TEST_KEY)
  })

  it('refuses a live key on the sandbox side (N12)', () => {
    expect(() => parseEnv({ ...OTE, ...flw(LIVE_KEY) })).toThrow(/FLWSECK_TEST-/)
  })

  it('refuses a test key on the live side', () => {
    expect(() => parseEnv({ ...LIVE, ...flw(TEST_KEY) })).toThrow(/live key/)
  })

  it('refuses a live key anywhere but production', () => {
    expect(() => parseEnv({ ...BASE, ...flw(LIVE_KEY) })).toThrow(/outside production/)
  })

  it('takes the live key in a production deployment', () => {
    expect(parseEnv({ ...LIVE, ...flw(LIVE_KEY) }).FLUTTERWAVE_SECRET_KEY).toBe(LIVE_KEY)
  })

  it('sends a live key to Flutterwave and nowhere else', () => {
    expect(() =>
      parseEnv({
        ...LIVE,
        ...flw(LIVE_KEY),
        FLUTTERWAVE_API_URL: 'https://flutterwave.attacker.test/v3',
      }),
    ).toThrow(/only sent to https:\/\/api\.flutterwave\.com\/v3/)
  })

  it('lets a test key go to a local mock', () => {
    const env = parseEnv({
      ...OTE,
      ...flw(TEST_KEY),
      FLUTTERWAVE_API_URL: 'http://127.0.0.1:4010/v3',
    })
    expect(env.FLUTTERWAVE_API_URL).toBe('http://127.0.0.1:4010/v3')
  })

  it('needs the Telegram token and chat together, and checks their shape', () => {
    const token = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'
    expect(() => parseEnv({ ...BASE, TELEGRAM_BOT_TOKEN: token })).toThrow(/together/)
    expect(() => parseEnv({ ...BASE, TELEGRAM_CHAT_ID: '-100123' })).toThrow(/together/)
    expect(() => parseEnv({ ...BASE, TELEGRAM_BOT_TOKEN: 'nope', TELEGRAM_CHAT_ID: '1' })).toThrow(
      /Telegram bot token/,
    )
    expect(() => parseEnv({ ...BASE, TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: '@me' })).toThrow(
      /chat id/,
    )
    expect(
      parseEnv({ ...BASE, TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: '-100123' })
        .TELEGRAM_CHAT_ID,
    ).toBe('-100123')
  })
})

describe('scheduled job settings', () => {
  it('syncs the catalogue weekly and checks delegation every half hour by default', () => {
    const env = parseEnv(BASE)
    expect(env.CATALOGUE_SYNC_EVERY_HOURS).toBe(168)
    expect(env.DELEGATION_CHECK_MINUTES).toBe(30)
  })

  it('keeps the intervals within sense', () => {
    expect(() => parseEnv({ ...BASE, CATALOGUE_SYNC_EVERY_HOURS: '0' })).toThrow()
    expect(() => parseEnv({ ...BASE, CATALOGUE_SYNC_EVERY_HOURS: '1000' })).toThrow()
    expect(() => parseEnv({ ...BASE, DELEGATION_CHECK_MINUTES: '1' })).toThrow()
    expect(parseEnv({ ...BASE, CATALOGUE_SYNC_EVERY_HOURS: '24' }).CATALOGUE_SYNC_EVERY_HOURS).toBe(
      24,
    )
  })

  it('asks the site to refresh prices only when it knows the site’s address', () => {
    expect(parseEnv(BASE).APP_URL).toBeUndefined()
    expect(parseEnv({ ...BASE, APP_URL: 'https://www.mydomainshub.com' }).APP_URL).toBe(
      'https://www.mydomainshub.com',
    )
    expect(() => parseEnv({ ...BASE, APP_URL: 'www.mydomainshub.com' })).toThrow()
  })
})
