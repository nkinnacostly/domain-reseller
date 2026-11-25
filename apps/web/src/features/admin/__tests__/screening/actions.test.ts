import { cookies, headers } from 'next/headers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reviewScreening } from '@/features/admin/actions/screening'
import { ADMIN_ERROR_WORDS } from '@/features/admin/lib/errors'
import { createClient } from '@/lib/supabase/server'
import { sessionClient, whoami } from '../foundation/fixtures'

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const LINE = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f'
const KEY = '7d3c2b1a-0f9e-4d8c-8b7a-6f5e4d3c2b1a'
const review = {
  orderItemId: LINE,
  decision: 'abuse' as const,
  reason: 'Phishing page reported to the registrar',
  requestKey: KEY,
}

function as(role: 'owner' | 'operator' | 'viewer', rpc: Record<string, { data: unknown }> = {}) {
  const session = sessionClient({
    rpc: { admin_whoami: { data: whoami({ role, label: role }) }, ...rpc },
  })
  vi.mocked(createClient).mockResolvedValue(session.client as never)
  return session
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(headers).mockResolvedValue(new Headers() as never)
  vi.mocked(cookies).mockResolvedValue({ get: () => ({ value: 'live' }), set: vi.fn() } as never)
})

describe('reviewing a screened name (migration 73)', () => {
  it('records an operator’s decision through the audited wrapper, as the admin', async () => {
    const session = as('operator', { admin_review_screening: { data: { ok: true, auditId: 90 } } })
    const result = await reviewScreening(review)
    expect(session.rpc).toHaveBeenCalledWith('admin_review_screening', {
      p_order_item_id: LINE,
      p_decision: 'abuse',
      p_reason: 'Phishing page reported to the registrar',
      p_request_key: KEY,
    })
    expect(result.data).toEqual({ ok: true, auditId: 90 })
  })

  it('words a name that is no longer waiting', async () => {
    as('operator', {
      admin_review_screening: { data: { ok: false, code: 'NOT_FOR_REVIEW', auditId: 91 } },
    })
    expect((await reviewScreening(review)).data).toEqual({
      ok: false,
      code: 'NOT_FOR_REVIEW',
      message: ADMIN_ERROR_WORDS.NOT_FOR_REVIEW,
      auditId: 91,
    })
  })

  it('refuses a viewer before SQL is asked', async () => {
    const session = as('viewer')
    expect(await reviewScreening(review)).toEqual({
      serverError: "Your admin role can't do this. Ask the owner.",
    })
    expect(session.rpc).not.toHaveBeenCalledWith('admin_review_screening', expect.anything())
  })

  it('validates first: no line id, an unknown decision or a short reason — no call', async () => {
    const session = as('operator')
    for (const bad of [
      { ...review, orderItemId: 'paypal-login.com' },
      { ...review, decision: 'block' },
      { ...review, reason: 'ok' },
    ]) {
      expect(
        (await reviewScreening(bad as never)).validationErrors,
        JSON.stringify(bad),
      ).toBeDefined()
    }
    expect(session.rpc).not.toHaveBeenCalledWith('admin_review_screening', expect.anything())
  })
})
