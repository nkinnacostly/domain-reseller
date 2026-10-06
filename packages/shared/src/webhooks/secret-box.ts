import { fromBase64, toBase64 } from '../ses/base64'
import { randomBytes, utf8 } from '../ses/platform'

/**
 * A customer endpoint's signing secret, sealed at rest (MAIL-SPEC §9
 * `webhooks`: "secret encrypted at rest"). The dashboard makes the secret,
 * shows it once and seals it here; only the mail worker opens it, to sign a
 * delivery (MR6). Both hold `MAIL_WEBHOOK_SECRET_KEY` (32 random bytes,
 * base64); the database holds only the sealed form, so a copy of the
 * database — a backup, a leaked dump — signs nothing.
 *
 * AES-256-GCM with a fresh 96-bit IV per seal, and the account's id as
 * additional data: a sealed secret moved to another account's row does not
 * open. The form is `v1.<iv>.<ciphertext+tag>`, base64url, which migration
 * 49 checks. `v1` names this scheme and key; a new key gets a new prefix.
 */

type AesKey = { readonly type: string }
type AesParams = { name: 'AES-GCM'; iv: Uint8Array; additionalData: Uint8Array }
type Subtle = {
  importKey(
    format: 'raw',
    key: Uint8Array,
    algorithm: { name: 'AES-GCM' },
    extractable: false,
    usages: ['encrypt', 'decrypt'],
  ): Promise<AesKey>
  encrypt(params: AesParams, key: AesKey, data: Uint8Array): Promise<ArrayBuffer>
  decrypt(params: AesParams, key: AesKey, data: Uint8Array): Promise<ArrayBuffer>
}
const subtle = () => (globalThis as unknown as { crypto: { subtle: Subtle } }).crypto.subtle

const VERSION = 'v1'
const SEALED = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{40,300})$/

const toBase64Url = (bytes: Uint8Array) =>
  toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function fromBase64Url(text: string): Uint8Array | null {
  const standard = text.replace(/-/g, '+').replace(/_/g, '/')
  return fromBase64(standard.padEnd(Math.ceil(standard.length / 4) * 4, '='))
}

/** The 32-byte key in `MAIL_WEBHOOK_SECRET_KEY`, or null when it is not one. */
export function webhookSealKey(base64: string | null | undefined): Uint8Array | null {
  const key = base64 ? fromBase64(base64.trim()) : null
  return key && key.length === 32 ? key : null
}

const aad = (accountId: string) => utf8(`mdm-webhook:${accountId}`)

async function aesKey(key: Uint8Array): Promise<AesKey> {
  return subtle().importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/** Seals `secret` for the endpoint of `accountId`. */
export async function sealWebhookSecret(
  key: Uint8Array,
  secret: string,
  accountId: string,
): Promise<string> {
  if (key.length !== 32) throw new Error('webhook seal key must be 32 bytes')
  const iv = randomBytes(12)
  const sealed = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(accountId) },
    await aesKey(key),
    utf8(secret),
  )
  return `${VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(sealed))}`
}

/** The secret, or null when the form, the key or the account does not match. */
export async function openWebhookSecret(
  key: Uint8Array,
  sealed: string,
  accountId: string,
): Promise<string | null> {
  const match = SEALED.exec(sealed)
  const iv = match ? fromBase64Url(match[1] ?? '') : null
  const data = match ? fromBase64Url(match[2] ?? '') : null
  if (!iv || !data || key.length !== 32) return null
  try {
    const plain = await subtle().decrypt(
      { name: 'AES-GCM', iv, additionalData: aad(accountId) },
      await aesKey(key),
      data,
    )
    return fromUtf8(new Uint8Array(plain))
  } catch {
    return null
  }
}

/** UTF-8 decoding, typed without the DOM library. */
function fromUtf8(bytes: Uint8Array): string {
  const Decoder = (
    globalThis as unknown as { TextDecoder: new () => { decode(input: Uint8Array): string } }
  ).TextDecoder
  return new Decoder().decode(bytes)
}

/** `whsec_` and the secret's first four characters: tells secrets apart, reveals nothing. */
export function webhookSecretHint(secret: string): string {
  return `whsec_${secret.replace(/^whsec_/, '').slice(0, 4)}`
}
