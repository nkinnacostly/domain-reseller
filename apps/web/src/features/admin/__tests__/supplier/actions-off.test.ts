import { cookies, headers } from 'next/headers'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyPriceList, previewPriceList } from '@/features/admin/actions/supplier'
import { createClient } from '@/lib/supabase/server'
import { sessionClient, whoami } from '../foundation/fixtures'

/**
 * A dashboard deployed without GATEWAY_ADMIN_SECRET: a price-list preview or
 * apply says live reads are off and writes no audit note. Its own file,
 * because the environment is read once per module graph.
 */

vi.hoisted(() => {
  vi.stubEnv('GATEWAY_URL', 'http://gateway.test')
  vi.stubEnv('GATEWAY_SHARED_SECRET', 'test-secret-value-16')
  vi.stubEnv('GATEWAY_ADMIN_SECRET', '')
})
afterAll(() => vi.unstubAllEnvs())

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('next/cache', () => ({ revalidateTag: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(headers).mockResolvedValue(new Headers() as never)
  vi.mocked(cookies).mockResolvedValue({ get: () => ({ value: 'live' }), set: vi.fn() } as never)
})

describe('price lists without the admin secret', () => {
  it.each([
    ['a preview', () => previewPriceList({})],
    [
      'an apply',
      () => applyPriceList({ code: '123456', requestKey: '7d3c2b1a-0f9e-4d8c-8b7a-6f5e4d3c2b1a' }),
    ],
  ])('refuses %s as ADMIN_DISABLED, and writes no audit note', async (_, run) => {
    const session = sessionClient({
      rpc: {
        admin_whoami: { data: whoami({ role: 'owner' }) },
        admin_note: { data: { ok: true, auditId: 41 } },
      },
    })
    vi.mocked(createClient).mockResolvedValue(session.client as never)
    const result = await run()
    expect(result.data).toMatchObject({ ok: false, code: 'ADMIN_DISABLED' })
    expect(session.rpc).not.toHaveBeenCalledWith('admin_note', expect.anything())
  })
})
