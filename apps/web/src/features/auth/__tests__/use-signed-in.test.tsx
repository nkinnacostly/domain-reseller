import { createBrowserClient } from '@supabase/ssr'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSignedIn } from '../lib/use-signed-in'

vi.mock('@supabase/ssr', () => ({ createBrowserClient: vi.fn() }))

type Listener = (event: string, session: unknown) => void

/** A browser Supabase client whose session and auth events the test controls. */
function browserClient(session: unknown) {
  const auth = {
    listener: undefined as Listener | undefined,
    unsubscribe: vi.fn(),
  }
  vi.mocked(createBrowserClient).mockReturnValue({
    auth: {
      getSession: vi.fn(async () => ({ data: { session } })),
      onAuthStateChange: vi.fn((listener: Listener) => {
        auth.listener = listener
        return { data: { subscription: { unsubscribe: auth.unsubscribe } } }
      }),
    },
  } as never)
  return auth
}

beforeEach(() => vi.clearAllMocks())

describe('useSignedIn', () => {
  it('assumes signed out until the browser has been checked', () => {
    vi.mocked(createBrowserClient).mockReturnValue({
      auth: {
        getSession: () => new Promise(() => {}),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
      },
    } as never)
    const { result } = renderHook(() => useSignedIn())
    expect(result.current).toBe(false)
  })

  it('reports signed in when this browser holds a session', async () => {
    browserClient({ access_token: 'token' })
    const { result } = renderHook(() => useSignedIn())
    await waitFor(() => expect(result.current).toBe(true))
  })

  it('stays signed out without a session', async () => {
    const auth = browserClient(null)
    const { result } = renderHook(() => useSignedIn())
    await waitFor(() => expect(auth.listener).toBeDefined())
    expect(result.current).toBe(false)
  })

  it('follows sign-in and sign-out in another tab', async () => {
    const auth = browserClient(null)
    const { result } = renderHook(() => useSignedIn())
    await waitFor(() => expect(auth.listener).toBeDefined())

    act(() => auth.listener?.('SIGNED_IN', { access_token: 'token' }))
    expect(result.current).toBe(true)

    act(() => auth.listener?.('SIGNED_OUT', null))
    expect(result.current).toBe(false)
  })

  it('stops listening once the header unmounts', async () => {
    const auth = browserClient(null)
    const { unmount } = renderHook(() => useSignedIn())
    await waitFor(() => expect(auth.listener).toBeDefined())

    unmount()

    expect(auth.unsubscribe).toHaveBeenCalledTimes(1)
  })
})
