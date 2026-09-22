import { describe, expect, it } from 'vitest'
import { parseTransferQuery, transferCheckHref } from '../lib/href'

describe('parseTransferQuery', () => {
  it('needs an extension — a bare name cannot be transferred', () => {
    expect(parseTransferQuery('getpaid')).toEqual({ ok: false, reason: 'no-extension' })
  })

  it('rejects input that is not a domain', () => {
    expect(parseTransferQuery('get paid!')).toEqual({ ok: false, reason: 'invalid' })
    expect(parseTransferQuery('   ')).toEqual({ ok: false, reason: 'empty' })
  })

  it('accepts a pasted URL the way people actually paste it', () => {
    expect(parseTransferQuery('https://www.GetPaid.com/about')).toEqual({
      ok: true,
      domain: 'getpaid.com',
      tld: 'com',
    })
  })

  it('keeps a multi-label extension intact', () => {
    expect(parseTransferQuery('getpaid.co.uk')).toEqual({
      ok: true,
      domain: 'getpaid.co.uk',
      tld: 'co.uk',
    })
  })
})

describe('transferCheckHref', () => {
  it('lands on the result', () => {
    expect(transferCheckHref('getpaid.com')).toBe('/transfer?domain=getpaid.com#check')
  })
})
