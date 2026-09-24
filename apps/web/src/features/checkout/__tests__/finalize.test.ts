import { beforeEach, describe, expect, it, vi } from 'vitest'
import { verifyTransaction } from '@/lib/flutterwave'
import { logger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/service'

vi.mock('@/lib/flutterwave', () => ({ verifyTransaction: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/env', async (original) => ({
  ...(await original<typeof import('@/lib/env')>()),
  requirePaymentEnv: () => ({ testMode: true }),
}))

const { finalizePayment, markOrderCancelled } = await import('../queries/finalize')

const ORDER = {
  id: 'order-1',
  tx_ref: 'ord_1',
  total_kobo: 1_978_000,
  status: 'awaiting_payment',
  test_mode: true,
}

function service({
  rpcError = null as unknown,
  incidentError = null as unknown,
  order = ORDER as unknown,
  orderError = null as unknown,
} = {}) {
  const rpc = vi.fn(async (name: string, _args?: unknown) => ({
    data: 'paid',
    error: name === 'record_payment_incident' ? incidentError : rpcError,
  }))
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: order, error: orderError }) }),
      }),
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

const found = (overrides = {}) => ({ kind: 'found' as const, transaction: tx(overrides) })

beforeEach(() => vi.clearAllMocks())

describe('finalizePayment', () => {
  it('records a verified payment through the one-shot database function', async () => {
    const rpc = service()
    vi.mocked(verifyTransaction).mockResolvedValue(found())
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

  it('keeps the charge, never the customer or the reusable card token (N13)', async () => {
    const rpc = service()
    vi.mocked(verifyTransaction).mockResolvedValue(
      found({
        flw_ref: 'FLW-1',
        customer: { email: 'ada@example.com', name: 'Ada Okafor' },
        card: { token: 'flw-t1nf-secret', last_4digits: '2950' },
      }),
    )
    await finalizePayment('order-1', '4242')
    const args = rpc.mock.calls.find(([name]) => name === 'record_order_payment')?.[1]
    expect((args as { p_raw: unknown }).p_raw).toEqual({
      id: 4242,
      tx_ref: 'ord_1',
      flw_ref: 'FLW-1',
      status: 'successful',
      amount: 19_780,
      currency: 'NGN',
      payment_type: 'card',
    })
  })

  it('never applies another order’s transaction, and records the attempt', async () => {
    const rpc = service()
    vi.mocked(verifyTransaction).mockResolvedValue(found({ tx_ref: 'ord_2' }))
    expect(await finalizePayment('order-1', '4242')).toBe('mismatch')
    expect(rpc).not.toHaveBeenCalledWith('record_order_payment', expect.anything())
    expect(rpc).toHaveBeenCalledWith('record_payment_incident', {
      p_kind: 'tx_ref_mismatch',
      p_order_id: 'order-1',
      p_provider_reference: '4242',
      p_detail: { status: 'successful', currency: 'NGN', amount_kobo: 1_978_000 },
    })
  })

  it('never applies another currency, and records it for a person', async () => {
    const rpc = service()
    vi.mocked(verifyTransaction).mockResolvedValue(found({ currency: 'USD' }))
    expect(await finalizePayment('order-1', '4242')).toBe('mismatch')
    expect(rpc).toHaveBeenCalledWith(
      'record_payment_incident',
      expect.objectContaining({ p_kind: 'currency_mismatch' }),
    )
  })

  it('never settles a live order with the test key, or the reverse (N12)', async () => {
    const rpc = service({ order: { ...ORDER, test_mode: false } })
    expect(await finalizePayment('order-1', '4242')).toBe('mismatch')
    expect(verifyTransaction).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledWith('record_payment_incident', {
      p_kind: 'mode_mismatch',
      p_order_id: 'order-1',
      p_provider_reference: '4242',
      p_detail: { order_test_mode: false },
    })
  })

  it('sends a short payment back in full instead of applying it', async () => {
    const rpc = service()
    vi.mocked(verifyTransaction).mockResolvedValue(found({ amount: 5_000 }))
    expect(await finalizePayment('order-1', '4242')).toBe('underpaid')
    expect(rpc).toHaveBeenCalledWith(
      'record_underpayment',
      expect.objectContaining({ p_order_id: 'order-1', p_amount_kobo: 500_000 }),
    )
    expect(rpc).not.toHaveBeenCalledWith('record_order_payment', expect.anything())
  })

  it('a short payment that cannot be recorded is an incident, and asked again', async () => {
    const rpc = service({ rpcError: { message: 'db down' } })
    vi.mocked(verifyTransaction).mockResolvedValue(found({ amount: 5_000 }))
    expect(await finalizePayment('order-1', '4242')).toBe('unverified')
    expect(rpc).toHaveBeenCalledWith(
      'record_payment_incident',
      expect.objectContaining({ p_kind: 'unrecorded_payment' }),
    )
  })

  it('when Flutterwave cannot be reached, nothing is settled and it is asked again', async () => {
    const rpc = service()
    vi.mocked(verifyTransaction).mockResolvedValue({ kind: 'unreachable' })
    expect(await finalizePayment('order-1', '4242')).toBe('unverified')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('a transaction Flutterwave has never heard of leaves the order waiting', async () => {
    const rpc = service()
    vi.mocked(verifyTransaction).mockResolvedValue({ kind: 'missing' })
    expect(await finalizePayment('order-1', '4242')).toBe('pending')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('a verified payment that could not be recorded is an incident, and asked again', async () => {
    const rpc = service({ rpcError: { message: 'db down', code: '08006' } })
    vi.mocked(verifyTransaction).mockResolvedValue(found())
    expect(await finalizePayment('order-1', '4242')).toBe('unverified')
    expect(rpc).toHaveBeenCalledWith(
      'record_payment_incident',
      expect.objectContaining({ p_kind: 'unrecorded_payment' }),
    )
  })

  it('an order that cannot be read is asked again, not treated as unknown', async () => {
    service({ order: null, orderError: { message: 'fetch failed' } })
    expect(await finalizePayment('order-1', '4242')).toBe('unverified')
    expect(verifyTransaction).not.toHaveBeenCalled()
  })

  it('treats an unknown order as a mismatch without asking Flutterwave', async () => {
    service({ order: null })
    expect(await finalizePayment('nope', '4242')).toBe('mismatch')
    expect(verifyTransaction).not.toHaveBeenCalled()
  })
})

describe('finalizePayment — outcomes that settle nothing', () => {
  it.each([
    ['pending', 'pending'],
    ['failed', 'failed'],
    ['cancelled', 'failed'],
  ] as const)(
    'a %s transaction is reported as %s, and nothing is recorded',
    async (status, outcome) => {
      const rpc = service()
      vi.mocked(verifyTransaction).mockResolvedValue(found({ status }))
      expect(await finalizePayment('order-1', '4242')).toBe(outcome)
      expect(rpc).not.toHaveBeenCalled()
    },
  )

  it('still refuses a mismatch when the incident cannot be recorded, and logs that it was not', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    service({ incidentError: { message: 'db down' } })
    vi.mocked(verifyTransaction).mockResolvedValue(found({ tx_ref: 'ord_2' }))
    expect(await finalizePayment('order-1', '4242')).toBe('mismatch')
    expect(error).toHaveBeenCalledWith(
      { err: 'db down', orderId: 'order-1', kind: 'tx_ref_mismatch' },
      'payment incident not recorded',
    )
    error.mockRestore()
  })

  it('records a payment whose method Flutterwave did not name', async () => {
    const rpc = service()
    vi.mocked(verifyTransaction).mockResolvedValue(found({ payment_type: undefined }))
    await finalizePayment('order-1', '4242')
    expect(rpc).toHaveBeenCalledWith(
      'record_order_payment',
      expect.objectContaining({ p_method: '' }),
    )
  })
})

describe('markOrderCancelled', () => {
  it('closes the order only while it is still awaiting payment, so a paid order is never undone', async () => {
    const steps: unknown[][] = []
    const query = {
      update: (patch: unknown) => {
        steps.push(['update', patch])
        return query
      },
      eq: (column: string, value: unknown) => {
        steps.push(['eq', column, value])
        return query
      },
    }
    const from = vi.fn(() => query)
    vi.mocked(createServiceClient).mockReturnValue({ from } as never)

    await markOrderCancelled('order-1')

    expect(from).toHaveBeenCalledWith('orders')
    expect(steps).toEqual([
      ['update', { status: 'cancelled' }],
      ['eq', 'id', 'order-1'],
      ['eq', 'status', 'awaiting_payment'],
    ])
  })
})
