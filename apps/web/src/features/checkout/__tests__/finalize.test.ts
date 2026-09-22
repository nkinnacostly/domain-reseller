import { beforeEach, describe, expect, it, vi } from 'vitest'
import { verifyTransaction } from '@/lib/flutterwave'
import { createServiceClient } from '@/lib/supabase/service'

vi.mock('@/lib/flutterwave', () => ({ verifyTransaction: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))

const { finalizePayment } = await import('../queries/finalize')

const ORDER = { id: 'order-1', tx_ref: 'ord_1', total_kobo: 1_978_000, status: 'awaiting_payment' }

function service(rpcError: unknown = null) {
  const rpc = vi.fn(async () => ({ data: 'paid', error: rpcError }))
  const client = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: ORDER }) }) }),
    }),
    rpc,
  }
  vi.mocked(createServiceClient).mockReturnValue(client as never)
  return rpc
}

const tx = (overrides = {}) => ({
  id: 4242,
  tx_ref: 'ord_1',
  status: 'successful',
  amount: 19_780,
  currency: 'NGN',
  payment_type: 'card',
  ...overrides,
})

beforeEach(() => vi.clearAllMocks())

describe('finalizePayment', () => {
  it('records a verified payment through the one-shot database function', async () => {
    const rpc = service()
    vi.mocked(verifyTransaction).mockResolvedValue(tx())
    expect(await finalizePayment('order-1', '4242')).toBe('paid')
    expect(rpc).toHaveBeenCalledWith(
      'record_order_payment',
      expect.objectContaining({
        p_order_id: 'order-1',
        p_provider_reference: '4242',
        p_amount_kobo: 1_978_000,
      }),
    )
  })

  it('records nothing for a payment that does not match the order', async () => {
    const rpc = service()
    vi.mocked(verifyTransaction).mockResolvedValue(tx({ amount: 1 }))
    expect(await finalizePayment('order-1', '4242')).toBe('mismatch')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('waits when Flutterwave cannot confirm yet, rather than failing the order', async () => {
    const rpc = service()
    vi.mocked(verifyTransaction).mockResolvedValue(null)
    expect(await finalizePayment('order-1', '4242')).toBe('pending')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('reports pending, not paid, when the payment could not be recorded', async () => {
    service({ message: 'db down' })
    vi.mocked(verifyTransaction).mockResolvedValue(tx())
    expect(await finalizePayment('order-1', '4242')).toBe('pending')
  })
})
