import { describe, expect, it } from 'vitest'
import { DEFAULT_AFTER_SIGN_IN, safeNext } from '../lib/redirect'

const ORIGIN = 'https://naijadomains.test'

describe('safeNext — refusing to be an open redirect', () => {
  it.each([
    ['another site', 'https://evil.example/steal'],
    ['a protocol-relative URL', '//evil.example'],
    ['a backslash trick', '/\\evil.example'],
    ['a dot segment that normalises to //', '/.//evil.example'],
    ['a parent segment that normalises to //', '/x/..//evil.example'],
    ['an encoded parent segment that normalises to //', '/%2e%2e//evil.example'],
    ['a script URL', 'javascript:alert(1)'],
    ['garbage', 'http://'],
  ])('falls back for %s', (_, next) => {
    expect(safeNext(next, ORIGIN)).toBe(DEFAULT_AFTER_SIGN_IN)
  })

  it('never sends someone back into the sign-in pages', () => {
    expect(safeNext('/sign-in', ORIGIN)).toBe(DEFAULT_AFTER_SIGN_IN)
    expect(safeNext('/sign-up?next=/x', ORIGIN)).toBe(DEFAULT_AFTER_SIGN_IN)
    expect(safeNext('/auth/callback?code=1', ORIGIN)).toBe(DEFAULT_AFTER_SIGN_IN)
    expect(safeNext('/', ORIGIN)).toBe(DEFAULT_AFTER_SIGN_IN)
  })

  it('falls back when there is nothing to go back to', () => {
    expect(safeNext(null, ORIGIN)).toBe(DEFAULT_AFTER_SIGN_IN)
    expect(safeNext('', ORIGIN)).toBe(DEFAULT_AFTER_SIGN_IN)
  })

  it('keeps a same-site path, with its query and fragment', () => {
    expect(safeNext('/app/settings?tab=security#two-factor', ORIGIN)).toBe(
      '/app/settings?tab=security#two-factor',
    )
  })

  it('reduces a full same-site URL to its path', () => {
    expect(safeNext(`${ORIGIN}/app/domains`, ORIGIN)).toBe('/app/domains')
  })

  it('does not mistake a look-alike prefix for an auth page', () => {
    expect(safeNext('/sign-in-help', ORIGIN)).toBe('/sign-in-help')
  })
})
