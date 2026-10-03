import { cookies, headers } from 'next/headers'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { lookupDomain, readLiveBalance } from '@/features/admin/actions/supplier-live'
import { adminGatewayConfigured } from '@/features/admin/queries/gateway'
import { createClient } from '@/lib/supabase/server'
import { sessionClient, whoami } from './fixtures'

/**
 * A dashboard deployed without GATEWAY_ADMIN_SECRET (DEPLOY §6b): live reads
 * say they are off — not the crash words, which the dialog would read as an
 * unknown outcome — and write no audit note first. Its own file, because the
 * environment is read once per module graph.
 */

vi.hoisted(() => {
  vi.stubEnv('GATEWAY_URL', 'http://gateway.test')
  vi.stubEnv('GATEWAY_SHARED_SECRET', 'test-secret-value-16')
  vi.stubEnv('GATEWAY_ADMIN_SECRET', '')
})
afterAll(() => vi.unstubAllEnvs())

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(headers).mockResolvedValue(new Headers() as never)
  vi.mocked(cookies).mockResolvedValue({ get: () => ({ value: 'live' }), set: vi.fn() } as never)
})

describe('live reads without the admin secret', () => {
  it('knows the secret is missing', () => {
    expect(adminGatewayConfigured()).toBe(false)
  })

  it.each([
    ['the balance', () => readLiveBalance({})],
    ['a domain lookup', () => lookupDomain({ name: 'example.com' })],
  ])('refuses %s as ADMIN_DISABLED, and writes no audit note', async (_, run) => {
    const session = sessionClient({
      rpc: {
        admin_whoami: { data: whoami({ role: 'operator', label: 'ops' }) },
        admin_note: { data: { ok: true, auditId: 41 } },
      },
    })
    vi.mocked(createClient).mockResolvedValue(session.client as never)

    const result = await run()

    expect(result.data).toEqual({
      ok: false,
      code: 'ADMIN_DISABLED',
      message:
        'Live reads are off: the admin secret the dashboard shares with the gateway is not set.',
    })
    expect(result.serverError).toBeUndefined()
    expect(session.rpc.mock.calls.map(([name]) => name)).not.toContain('admin_note')
  })
})
