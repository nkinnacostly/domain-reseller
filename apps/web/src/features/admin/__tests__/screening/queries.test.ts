import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getScreenings } from '@/features/admin/queries/screening'
import { fakeService, filterOf, principal } from '../audit/fake-db'

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))

const LINE = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f'
const ORDER = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d'
const NOW = new Date('2026-11-25T12:00:00Z')

const screening = (overrides: Record<string, unknown> = {}) => ({
  order_item_id: LINE,
  domain: 'paypal-login.com',
  matched: ['paypal', 'login'],
  note: 'Imitates a PayPal sign-in page',
  model: 'deepseek-flash',
  screened_at: '2026-11-25T10:00:00Z',
  decision: null,
  review_note: null,
  reviewed_by: null,
  reviewed_at: null,
  ...overrides,
})

beforeEach(() => vi.clearAllMocks())

describe('getScreenings', () => {
  it('reads what waits, what was reviewed and the counts on the side shown, with each order', async () => {
    const reads = fakeService((read) => {
      if (read.table === 'order_items') return { data: [{ id: LINE, order_id: ORDER }] }
      if (read.options?.head) return { count: filterOf(read, 'eq', 'verdict') ? 40 : 42 }
      if (filterOf(read, 'eq', 'verdict') === 'review') return { data: [screening()] }
      return { data: [] }
    })
    const data = await getScreenings(await principal({ role: 'operator' }), 'live', NOW)
    expect(data).toEqual({
      open: [
        {
          orderItemId: LINE,
          orderId: ORDER,
          domain: 'paypal-login.com',
          matched: ['paypal', 'login'],
          note: 'Imitates a PayPal sign-in page',
          model: 'deepseek-flash',
          screenedAt: '2026-11-25T10:00:00Z',
          decision: null,
          reviewNote: null,
          reviewedBy: null,
          reviewedAt: null,
        },
      ],
      reviewed: [],
      screened: 42,
      cleared: 40,
    })
    const screenings = reads.filter((read) => read.table === 'order_screenings')
    expect(screenings).toHaveLength(4)
    for (const read of screenings) expect(filterOf(read, 'eq', 'test_mode')).toBe(false)
    expect(filterOf(screenings[1], 'gte', 'reviewed_at')).toBe('2026-10-26T12:00:00.000Z')
  })

  it('answers null when a read fails, and keeps no link when the orders cannot be read', async () => {
    fakeService(() => ({ error: { message: 'down' } }))
    expect(await getScreenings(await principal({ role: 'operator' }), 'live', NOW)).toBeNull()

    fakeService((read) =>
      read.table === 'order_items'
        ? { error: { message: 'down' } }
        : read.options?.head
          ? { count: 1 }
          : { data: [screening({ decision: 'fine', reviewed_at: '2026-11-24T09:00:00Z' })] },
    )
    const data = await getScreenings(await principal({ role: 'operator' }), 'test', NOW)
    expect(data?.open[0]?.orderId).toBeNull()
  })
})
