import { describe, expect, it } from 'vitest'
import { toBase64 } from '../ses/base64'
import {
  openWebhookSecret,
  sealWebhookSecret,
  webhookSealKey,
  webhookSecretHint,
} from './secret-box'
import { newWebhookSecret } from './standard-webhooks'

/**
 * Sealed signing secrets (MAIL-SPEC §9, MR6): only the key opens one, only
 * for the account it was sealed for, and the form is the one migration 49
 * accepts.
 */

const KEY = new Uint8Array(32).map((_, i) => i + 1)
const OTHER_KEY = new Uint8Array(32).map((_, i) => 200 - i)
const ACCOUNT = '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e'
const SQL_FORM = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{40,}$/

describe('sealing a webhook secret', () => {
  it('seals in the form SQL accepts, and opens with the same key for the same account', async () => {
    const secret = newWebhookSecret()
    const sealed = await sealWebhookSecret(KEY, secret, ACCOUNT)
    expect(sealed).toMatch(SQL_FORM)
    expect(sealed.length).toBeLessThanOrEqual(320)
    expect(sealed).not.toContain(secret.slice(6))
    expect(await openWebhookSecret(KEY, sealed, ACCOUNT)).toBe(secret)
  })

  it('uses a fresh IV every time', async () => {
    const secret = newWebhookSecret()
    expect(await sealWebhookSecret(KEY, secret, ACCOUNT)).not.toBe(
      await sealWebhookSecret(KEY, secret, ACCOUNT),
    )
  })

  it('opens nothing with another key, for another account, or once tampered with', async () => {
    const sealed = await sealWebhookSecret(KEY, newWebhookSecret(), ACCOUNT)
    expect(await openWebhookSecret(OTHER_KEY, sealed, ACCOUNT)).toBeNull()
    expect(await openWebhookSecret(KEY, sealed, '6f1d3a52-2a0e-4f0b-9d55-0c1f2a3b4c5d')).toBeNull()
    const last = sealed.at(-1) === 'A' ? 'B' : 'A'
    expect(await openWebhookSecret(KEY, `${sealed.slice(0, -1)}${last}`, ACCOUNT)).toBeNull()
    expect(await openWebhookSecret(KEY, 'v2.whatever', ACCOUNT)).toBeNull()
    expect(
      await openWebhookSecret(KEY, `v1.${'*'.repeat(16)}.${'A'.repeat(60)}`, ACCOUNT),
    ).toBeNull()
    expect(await openWebhookSecret(new Uint8Array(16), sealed, ACCOUNT)).toBeNull()
  })

  it('refuses to seal with a key that is not 32 bytes', async () => {
    await expect(sealWebhookSecret(new Uint8Array(16), 'whsec_x', ACCOUNT)).rejects.toThrow(
      '32 bytes',
    )
  })
})

describe('the key and the hint', () => {
  it('reads MAIL_WEBHOOK_SECRET_KEY only when it is 32 bytes of base64', () => {
    expect(webhookSealKey(toBase64(KEY))).toEqual(KEY)
    expect(webhookSealKey(` ${toBase64(KEY)}\n`)).toEqual(KEY)
    expect(webhookSealKey(toBase64(new Uint8Array(16)))).toBeNull()
    expect(webhookSealKey('not base64!')).toBeNull()
    expect(webhookSealKey('')).toBeNull()
    expect(webhookSealKey(undefined)).toBeNull()
  })

  it('hints at a secret with its first four characters only', () => {
    expect(webhookSecretHint('whsec_AbC9restofthesecret')).toBe('whsec_AbC9')
    expect(webhookSecretHint(newWebhookSecret())).toMatch(/^whsec_[A-Za-z0-9+/]{4}$/)
  })
})
