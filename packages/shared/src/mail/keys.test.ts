import { describe, expect, it } from 'vitest'
import { apiKeyPrefix, bearerKey, hashApiKey, isApiKey, newApiKey } from './keys'

const PEPPER = 'p'.repeat(32)

describe('API keys (MR7)', () => {
  it('are mdh_live_ and 40 letters and digits, shown with their first four', () => {
    const { key, prefix } = newApiKey()
    expect(key).toMatch(/^mdh_live_[A-Za-z0-9]{40}$/)
    expect(isApiKey(key)).toBe(true)
    expect(prefix).toBe(key.slice(0, 13))
    expect(apiKeyPrefix('mdh_live_ab12cd34')).toBe('mdh_live_ab12')
    expect(newApiKey().key).not.toBe(key)
  })

  it('draw evenly: bytes past the last whole alphabet are thrown away', () => {
    let first = true
    const bytes = (n: number) => {
      // First all 255 (refused), then 0, 61, 62 → A, 9, A …
      const out = new Uint8Array(n).fill(first ? 255 : 0)
      if (!first) {
        out[1] = 61
        out[2] = 62
      }
      first = false
      return out
    }
    expect(newApiKey(bytes).key.slice(9, 12)).toBe('A9A')
  })

  it('are stored as sha256(pepper ‖ key) in hex, and need a real pepper', async () => {
    const hash = await hashApiKey('mdh_live_abc', PEPPER)
    // sha256("ppp…p" (32) + "mdh_live_abc"), computed independently with Node's crypto.
    expect(hash).toBe('43eb558cb9d8bcf65366d1307905151b19b3643b706beb71539a48ded352cb6a')
    expect(await hashApiKey('mdh_live_abc', PEPPER)).toBe(hash)
    expect(await hashApiKey('mdh_live_abd', PEPPER)).not.toBe(hash)
    expect(await hashApiKey('mdh_live_abc', 'q'.repeat(32))).not.toBe(hash)
    await expect(hashApiKey('mdh_live_abc', 'short')).rejects.toThrow('pepper')
  })

  it('arrive as a Bearer token, and nothing else', () => {
    expect(bearerKey('Bearer mdh_live_x')).toBe('mdh_live_x')
    expect(bearerKey('bearer   mdh_live_x ')).toBe('mdh_live_x')
    expect(bearerKey('Basic abc')).toBeNull()
    expect(bearerKey('Bearer')).toBeNull()
    expect(bearerKey('Bearer a b')).toBeNull()
    expect(bearerKey(null)).toBeNull()
    expect(isApiKey(`mdh_test_${'a'.repeat(40)}`)).toBe(false)
  })
})
