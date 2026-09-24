import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const { getOrder, getOrderRefunds, getOrders } = await import('../queries/orders')

const ORDER_ID = '6f1c2a4e-0b7d-4c1e-9a55-2d8f0e3b7c10'
type Step = [string, ...unknown[]]

/** The user's own client (RLS): records the query chain and answers with `answer`. */
function userClient(answer: { data: unknown; error?: unknown }) {
  const steps: Step[] = []
  const query = Promise.resolve(answer) as Promise<typeof answer> & Record<string, unknown>
  for (const method of ['select', 'eq', 'order', 'limit']) {
    query[method] = (...args: unknown[]) => {
      steps.push([method, ...args])
      return query
    }
  }
  query.maybeSingle = () => Promise.resolve(answer)
  const rpc = vi.fn(async (_name: string, _args: unknown) => answer)
  const from = vi.fn(() => query)
  vi.mocked(createClient).mockResolvedValue({ from, rpc } as never)
  return { steps, rpc, from }
}

beforeEach(() => vi.resetAllMocks())

describe('getOrders', () => {
  it('lists the latest 50 orders, newest first', async () => {
    const rows = [{ id: ORDER_ID, order_number: 'ND-001001' }]
    const { steps, from } = userClient({ data: rows })
    expect(await getOrders()).toBe(rows)
    expect(from).toHaveBeenCalledWith('orders')
    expect(steps).toContainEqual(['order', 'created_at', { ascending: false }])
    expect(steps).toContainEqual(['limit', 50])
  })

  it('reads what each line is, so a renewal can be told from a registration', async () => {
    const { steps } = userClient({ data: [] })
    await getOrders()
    const [, columns] = steps.find(([method]) => method === 'select') ?? []
    expect(columns).toContain('order_items(domain, item_type)')
  })

  it('is an empty list when nothing comes back', async () => {
    userClient({ data: null })
    expect(await getOrders()).toEqual([])
  })
})

describe('getOrder', () => {
  it.each(['order-1', `${ORDER_ID}'--`, ''])(
    'does not query for an id that is not a UUID: %j',
    async (id) => {
      expect(await getOrder(id)).toBeNull()
      expect(createClient).not.toHaveBeenCalled()
    },
  )

  it('reads one order by its id', async () => {
    const order = { id: ORDER_ID, status: 'paid' }
    const { steps } = userClient({ data: order })
    expect(await getOrder(ORDER_ID)).toBe(order)
    expect(steps).toContainEqual(['eq', 'id', ORDER_ID])
  })

  it('reads each line’s id and type with its domain, so renewal lines show as renewals', async () => {
    const { steps } = userClient({ data: null })
    await getOrder(ORDER_ID)
    const [, columns] = steps.find(([method]) => method === 'select') ?? []
    expect(columns).toMatch(/order_items\(id, item_type, domain, /)
  })

  it('accepts an upper-case UUID', async () => {
    userClient({ data: null })
    expect(await getOrder(ORDER_ID.toUpperCase())).toBeNull()
    expect(createClient).toHaveBeenCalled()
  })
})

describe('getOrderRefunds', () => {
  it('asks the database function, which checks ownership, and turns money into numbers', async () => {
    const { rpc } = userClient({
      data: [
        {
          id: 'refund-1',
          domain: 'getpaid.com',
          reason: 'registration_failed',
          amount_kobo: '1840000',
          state: 'refunded',
          refunded_at: '2026-09-24T09:00:00Z',
          test_mode: false,
        },
      ],
    })
    expect(await getOrderRefunds(ORDER_ID)).toEqual([
      {
        id: 'refund-1',
        domain: 'getpaid.com',
        reason: 'registration_failed',
        amountKobo: 1_840_000,
        state: 'refunded',
        refundedAt: '2026-09-24T09:00:00Z',
        testMode: false,
      },
    ])
    expect(rpc).toHaveBeenCalledWith('my_order_refunds', { p_order_id: ORDER_ID })
  })

  it('is empty when the order has none, or is not yours', async () => {
    userClient({ data: null })
    expect(await getOrderRefunds(ORDER_ID)).toEqual([])
  })
})
