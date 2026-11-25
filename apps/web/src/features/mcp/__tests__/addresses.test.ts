import { describe, expect, it } from 'vitest'
import { isAnthropicAddress } from '../lib/addresses'

describe('isAnthropicAddress', () => {
  it('matches 160.79.104.0/21 and nothing else', () => {
    expect(isAnthropicAddress('160.79.104.0')).toBe(true)
    expect(isAnthropicAddress('160.79.111.255')).toBe(true)
    expect(isAnthropicAddress('::ffff:160.79.105.7')).toBe(true)
    expect(isAnthropicAddress('160.79.112.0')).toBe(false)
    expect(isAnthropicAddress('160.79.103.255')).toBe(false)
    expect(isAnthropicAddress('2001:db8::1')).toBe(false)
    expect(isAnthropicAddress('160.79.104')).toBe(false)
    expect(isAnthropicAddress('160.79.104.256')).toBe(false)
    expect(isAnthropicAddress(undefined)).toBe(false)
  })
})
