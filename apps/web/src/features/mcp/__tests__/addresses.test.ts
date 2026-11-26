import { describe, expect, it } from 'vitest'
import { inIpv4Prefix, isAnthropicAddress, isOpenAiAddress } from '../lib/addresses'

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

describe('isOpenAiAddress (AI phase 5)', () => {
  const prefixes = ['104.210.139.192/28', '100.31.168.162/32']

  it('matches only inside the published prefixes', () => {
    expect(isOpenAiAddress('104.210.139.192', prefixes)).toBe(true)
    expect(isOpenAiAddress('104.210.139.207', prefixes)).toBe(true)
    expect(isOpenAiAddress('::ffff:100.31.168.162', prefixes)).toBe(true)
    expect(isOpenAiAddress('104.210.139.208', prefixes)).toBe(false)
    expect(isOpenAiAddress('100.31.168.163', prefixes)).toBe(false)
    expect(isOpenAiAddress('104.210.139.200', [])).toBe(false)
    expect(isOpenAiAddress(undefined, prefixes)).toBe(false)
  })

  it('reads a malformed prefix as matching nothing', () => {
    expect(inIpv4Prefix('10.0.0.1', '10.0.0.0/33')).toBe(false)
    expect(inIpv4Prefix('10.0.0.1', '10.0.0/8')).toBe(false)
    expect(inIpv4Prefix('10.0.0.1', '10.0.0.0')).toBe(false)
    expect(inIpv4Prefix('10.0.0.1', '0.0.0.0/0')).toBe(true)
  })
})
