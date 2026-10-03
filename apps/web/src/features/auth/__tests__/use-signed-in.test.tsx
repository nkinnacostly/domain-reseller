import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasSignedInHint, SIGNED_IN_HINT } from '../lib/signed-in-hint'
import { useSignedIn } from '../lib/use-signed-in'

const navigation = vi.hoisted(() => ({ pathname: '/' }))
vi.mock('next/navigation', () => ({ usePathname: () => navigation.pathname }))

/** The session cookies are httpOnly (ADMIN-SPEC §5.1): the header reads the proxy's hint. */

function setCookie(value: string | null) {
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API; the proxy sets this one
  document.cookie =
    value === null ? `${SIGNED_IN_HINT}=; max-age=0; path=/` : `${SIGNED_IN_HINT}=${value}; path=/`
}

afterEach(() => {
  setCookie(null)
  navigation.pathname = '/'
})

describe('the signed-in hint', () => {
  it('is exactly dr_signed_in=1', () => {
    expect(hasSignedInHint('a=b; dr_signed_in=1')).toBe(true)
    expect(hasSignedInHint('dr_signed_in=0')).toBe(false)
    expect(hasSignedInHint('xdr_signed_in=1')).toBe(false)
    expect(hasSignedInHint('')).toBe(false)
  })
})

describe('useSignedIn', () => {
  it('is signed out without the hint', () => {
    const { result } = renderHook(() => useSignedIn())
    expect(result.current).toBe(false)
  })

  it('is signed in with the hint', () => {
    setCookie('1')
    const { result } = renderHook(() => useSignedIn())
    expect(result.current).toBe(true)
  })

  it('reads again when the tab comes back into view, and after a navigation', () => {
    const { result, rerender } = renderHook(() => useSignedIn())
    expect(result.current).toBe(false)
    setCookie('1')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(result.current).toBe(true)
    setCookie(null)
    navigation.pathname = '/pricing'
    rerender()
    expect(result.current).toBe(false)
  })

  it('stops listening when it unmounts', () => {
    const remove = vi.spyOn(document, 'removeEventListener')
    const { unmount } = renderHook(() => useSignedIn())
    unmount()
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
  })
})
