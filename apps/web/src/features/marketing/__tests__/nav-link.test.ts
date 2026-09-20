import { describe, expect, it } from 'vitest'
import { isCurrentPath } from '@/components/layout/nav-link'

describe('isCurrentPath', () => {
  it('marks an exact match as current', () => {
    expect(isCurrentPath('/pricing', '/pricing')).toBe(true)
  })

  it('does not mark a different page as current', () => {
    expect(isCurrentPath('/pricing', '/transfer')).toBe(false)
  })

  it('marks a nested route as current, so /domains stays lit on /domains/ng', () => {
    expect(isCurrentPath('/domains', '/domains/ng')).toBe(true)
  })

  it('does not treat a prefix collision as nested', () => {
    // /transfer must not light up on /transfers
    expect(isCurrentPath('/transfer', '/transfers')).toBe(false)
  })

  it('only marks home as current on the exact root', () => {
    expect(isCurrentPath('/', '/')).toBe(true)
    expect(isCurrentPath('/', '/pricing')).toBe(false)
  })

  /**
   * A jump link is not a page. Marking it current would leave a nav item
   * permanently lit on the home page, which is noise rather than signal.
   */
  it('never marks a same-page anchor as current', () => {
    expect(isCurrentPath('/#how-it-works', '/')).toBe(false)
    expect(isCurrentPath('/#how-it-works', '/pricing')).toBe(false)
    expect(isCurrentPath('/pricing#faq', '/pricing')).toBe(false)
  })

  it('still marks an anchor on a DIFFERENT page as current when you are there', () => {
    // Linking to /pricing#faq from the home page is cross-page navigation.
    expect(isCurrentPath('/pricing#faq', '/')).toBe(false)
  })
})
