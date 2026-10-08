import { NextRequest } from 'next/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { proxy } from '@/proxy'
import { SUPABASE_URL } from '../../../../tests/mocks/supabase'

/**
 * The proxy asks admin_status on every signed-in page (MAIL-SPEC §10), so its
 * client sends through the same retrying fetch as the others, keeping the
 * person's forwarded headers beside it.
 */

const seen = vi.hoisted(() => ({
  options: null as { global: { headers: Record<string, string>; fetch: typeof fetch } } | null,
}))

vi.mock('@supabase/ssr', () => ({
  createServerClient: (_url: string, _key: string, options: never) => {
    seen.options = options
    return {
      auth: {
        getUser: async () => ({ data: { user: null } }),
        mfa: {
          getAuthenticatorAssuranceLevel: async () => ({
            data: { currentLevel: 'aal1', nextLevel: 'aal1', currentAuthenticationMethods: [] },
            error: null,
          }),
        },
      },
      rpc: async () => ({ data: 'not_admin', error: null }),
    }
  },
}))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the proxy’s Supabase client', () => {
  it('asks admin_status again after a dropped connection, with the forwarded headers kept', async () => {
    await proxy(
      new NextRequest('https://emails.mydomainshub.com/', {
        headers: { 'user-agent': 'Mozilla/5.0', 'x-real-ip': '102.89.1.2' },
      }),
    )
    const global = seen.options?.global
    expect(global?.headers).toEqual({
      'user-agent': 'Mozilla/5.0',
      'x-forwarded-for': '102.89.1.2',
    })

    const cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause }))
      .mockResolvedValueOnce(Response.json('ok'))
    const response = await global?.fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_status`, {
      method: 'POST',
      headers: { 'Content-Profile': 'public' },
      body: '{}',
    })
    expect(await response?.json()).toBe('ok')
    expect(network).toHaveBeenCalledTimes(2)
  })
})
