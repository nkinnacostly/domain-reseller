import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const { getReceipt } = await import('../queries/receipt')

const ORDER_ID = '6f1c2a4e-0b7d-4c1e-9a55-2d8f0e3b7c10'
type Step = [string, ...unknown[]]

const PAID = {
  id: ORDER_ID,
  order_number: 'ND-001001',
  invoice_number: 'TEST-INV-000007',
  paid_at: '2026-09-24T09:15:00Z',
  payment_id: 'payment-1',
  tx_ref: 'MDH-abc',
  subtotal_kobo: 1_840_000,
  vat_pct: 7.5,
  vat_kobo: 138_000,
  total_kobo: 1_978_000,
  registrant: { firstName: 'Ada', lastName: 'Okafor', country: 'NG' },
  test_mode: true,
  order_items: [],
  payments: [],
}

/**
 * The user's own client (RLS): records the query chain, answers the order
 * read with `order` and the refunds function with `refunds`.
 */
function userClient(
  order: { data: unknown; error?: { code?: string; message: string } | null },
  refunds: { data: unknown } = { data: [] },
) {
  const steps: Step[] = []
  const query = {} as Record<string, unknown>
  for (const method of ['select', 'eq']) {
    query[method] = (...args: unknown[]) => {
      steps.push([method, ...args])
      return query
    }
  }
  query.maybeSingle = async () => ({ error: null, ...order })
  const from = vi.fn(() => query)
  const rpc = vi.fn(async () => refunds)
  vi.mocked(createClient).mockResolvedValue({ from, rpc } as never)
  return { steps, from, rpc }
}

beforeEach(() => vi.resetAllMocks())

describe('getReceipt — whose receipt (RLS)', () => {
  it.each(['order-1', `${ORDER_ID}'--`, ''])(
    'does not query for an id that is not a UUID: %j',
    async (id) => {
      expect(await getReceipt(id)).toEqual({ state: 'missing' })
      expect(createClient).not.toHaveBeenCalled()
    },
  )

  it('finds nothing for an order that is not yours — RLS returns no row', async () => {
    const { steps, from } = userClient({ data: null })
    expect(await getReceipt(ORDER_ID)).toEqual({ state: 'missing' })
    expect(from).toHaveBeenCalledWith('orders')
    expect(steps).toContainEqual(['eq', 'id', ORDER_ID])
  })

  it('says the read failed, rather than that the order does not exist', async () => {
    userClient({ data: null, error: { code: '08006', message: 'connection lost' } })
    expect(await getReceipt(ORDER_ID)).toEqual({ state: 'error' })
  })
})

describe('getReceipt — paid or not', () => {
  it('has no receipt for an order that was never paid', async () => {
    userClient({ data: { ...PAID, invoice_number: null, paid_at: null } })
    expect(await getReceipt(ORDER_ID)).toEqual({
      state: 'unpaid',
      orderId: ORDER_ID,
      orderNumber: 'ND-001001',
    })
  })

  it('builds the receipt from the order, with its refunds from the ownership-checked function', async () => {
    const { rpc, steps } = userClient(
      { data: PAID },
      {
        data: [
          {
            id: 'refund-1',
            domain: 'getpaid.com',
            reason: 'registration_failed',
            amount_kobo: '1978000',
            state: 'processing',
            refunded_at: null,
            test_mode: true,
          },
        ],
      },
    )
    const lookup = await getReceipt(ORDER_ID)

    expect(rpc).toHaveBeenCalledWith('my_order_refunds', { p_order_id: ORDER_ID })
    const [, columns] = steps.find(([method]) => method === 'select') ?? []
    expect(columns).toMatch(/invoice_number/)
    // Every line column, so the renewal term (migration 37) is read where it exists.
    expect(columns).toMatch(/order_items\(\*\)/)
    expect(columns).toMatch(/payments\(id, provider_reference, amount_kobo, method/)
    expect(lookup).toMatchObject({
      state: 'ready',
      receipt: {
        invoiceNumber: 'TEST-INV-000007',
        testMode: true,
        customer: { name: 'Ada Okafor', address: ['Nigeria'] },
      },
      refunds: [{ id: 'refund-1', amountKobo: 1_978_000 }],
    })
  })

  it('shows a country code it cannot name as it is', async () => {
    userClient({ data: { ...PAID, registrant: { country: 'Q1' } } })
    const lookup = await getReceipt(ORDER_ID)
    expect(lookup.state === 'ready' && lookup.receipt.customer.address).toEqual(['Q1'])
  })
})
