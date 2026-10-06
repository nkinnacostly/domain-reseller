import { randomBytes, subtle, utf8 } from '../ses/platform'
import { hex } from '../ses/sigv4'

/**
 * API keys (MAIL-SPEC MR7): `mdh_live_` and 40 random letters and digits
 * (about 238 bits), shown once, stored only as `sha256(pepper ‖ key)` in hex,
 * with `mdh_live_` and the first four characters kept to tell keys apart.
 * The pepper lives in the app's environment, never in the database, so a
 * leaked table cannot be tried against guesses offline.
 */

export const API_KEY_PREFIX = 'mdh_live_'
export const API_KEY_RANDOM_CHARS = 40
/** How many random characters the visible prefix shows. */
export const API_KEY_SHOWN_CHARS = 4
/** A pepper shorter than this is a configuration mistake. */
export const API_KEY_PEPPER_MIN_CHARS = 32

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const KEY = new RegExp(`^${API_KEY_PREFIX}[A-Za-z0-9]{${API_KEY_RANDOM_CHARS}}$`)

/** Uniform over the alphabet: bytes of 248 and above are thrown away (248 = 4 × 62). */
function randomCharacters(count: number, bytes: (n: number) => Uint8Array = randomBytes): string {
  let out = ''
  while (out.length < count) {
    for (const byte of bytes(count * 2)) {
      if (byte < 248 && out.length < count) out += ALPHABET[byte % 62]
    }
  }
  return out
}

export type NewApiKey = { key: string; prefix: string }

export function newApiKey(bytes?: (n: number) => Uint8Array): NewApiKey {
  const key = `${API_KEY_PREFIX}${randomCharacters(API_KEY_RANDOM_CHARS, bytes)}`
  return { key, prefix: apiKeyPrefix(key) }
}

export const isApiKey = (value: string): boolean => KEY.test(value)

/** `mdh_live_ab12` — what the dashboard shows beside the key's name. */
export const apiKeyPrefix = (key: string): string =>
  key.slice(0, API_KEY_PREFIX.length + API_KEY_SHOWN_CHARS)

/** sha256(pepper ‖ key), hex — what `mail.api_keys.key_hash` holds. */
export async function hashApiKey(key: string, pepper: string): Promise<string> {
  if (pepper.length < API_KEY_PEPPER_MIN_CHARS) {
    throw new Error(`The API key pepper must be at least ${API_KEY_PEPPER_MIN_CHARS} characters`)
  }
  return hex(await subtle().digest('SHA-256', utf8(`${pepper}${key}`)))
}

/** The key in `Authorization: Bearer <key>`, or null. Only the scheme's case is forgiven. */
export function bearerKey(header: string | null | undefined): string | null {
  const match = /^Bearer[ ]+(\S+)\s*$/i.exec(header ?? '')
  return match?.[1] ?? null
}
