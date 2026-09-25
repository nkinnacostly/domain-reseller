import type { Fetch } from '@dr/shared/ses'
import { describe, expect, it, vi } from 'vitest'
import { parseEnv } from '../env'
import { emailSetupFor } from './provider'

const BASE = {
  GATEWAY_SHARED_SECRET: 'test-secret-value-at-least-16',
  DNA_RESELLER_ID: '00000000-0000-0000-0000-000000000000',
  DNA_API_KEY: 'x',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SECRET_KEY: 'x',
}
/** AWS's documented example key pair — never a real one. */
const SES = {
  AWS_SES_REGION: 'eu-west-2',
  AWS_SES_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  ['AWS_SES_SECRET_ACCESS_KEY' as string]: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  AWS_SES_CONFIGURATION_SET: 'mydomainshub',
}
const log = { error: vi.fn() }

describe('choosing the email provider', () => {
  it('is Brevo by default, with its key, polled for delivery and not paced', () => {
    const setup = emailSetupFor(
      parseEnv({ ...BASE, BREVO_API_KEY: 'xkeysib-test-key-000000' }),
      log,
    )
    expect(setup.provider).toBe('brevo')
    expect(setup.mailer?.provider).toBe('brevo')
    expect(setup.mailer?.delivery).toBeTypeOf('function')
    expect(setup).toMatchObject({ minIntervalMs: 0 })
  })

  it('waits for Brevo’s key, naming it — never the gateway', () => {
    expect(emailSetupFor(parseEnv(BASE), log)).toEqual({
      provider: 'brevo',
      mailer: null,
      missing: ['BREVO_API_KEY'],
    })
  })

  it('is SES when chosen, paced to one message a second by default, with nothing to poll', async () => {
    const fetch: Fetch = vi.fn(async () => ({
      status: 200,
      headers: { get: () => null },
      text: async () => '{"MessageId":"m-1"}',
    }))
    const setup = emailSetupFor(parseEnv({ ...BASE, ...SES, EMAIL_PROVIDER: 'ses' }), log, {
      fetch,
    })
    expect(setup.provider).toBe('ses')
    expect(setup).toMatchObject({ minIntervalMs: 1000 })
    expect(setup.mailer?.delivery).toBeUndefined()
    const sent = await setup.mailer?.send({
      to: 'ada@gmail.com',
      subject: 's',
      html: 'h',
      text: 't',
      tags: [],
    })
    expect(sent).toEqual({ ok: true, messageId: 'm-1' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('follows SES’s raised rate once AWS grants more', () => {
    const setup = emailSetupFor(
      parseEnv({ ...BASE, ...SES, EMAIL_PROVIDER: 'ses', SES_MAX_SEND_RATE: '14' }),
      log,
    )
    expect(setup).toMatchObject({ minIntervalMs: 72 })
  })

  it('does not fall back to Brevo when SES is chosen but its settings are missing', () => {
    const setup = emailSetupFor(
      parseEnv({
        ...BASE,
        BREVO_API_KEY: 'xkeysib-test-key-000000',
        EMAIL_PROVIDER: 'ses',
        AWS_SES_REGION: 'eu-west-2',
        AWS_SES_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
      }),
      log,
    )
    expect(setup).toEqual({
      provider: 'ses',
      mailer: null,
      missing: ['AWS_SES_SECRET_ACCESS_KEY', 'AWS_SES_CONFIGURATION_SET'],
    })
  })
})
