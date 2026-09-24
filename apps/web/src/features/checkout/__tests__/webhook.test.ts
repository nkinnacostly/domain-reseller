import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizePayment } from '@/features/checkout/queries/finalize'
import { withinLimit } from '@/lib/rate-limit'
import { createServiceClient } from '@/lib/supabase/service'

vi.mock('@/features/checkout/queries/finalize', () => ({ finalizePayment: vi.fn() }))
vi.mock('@/lib/rate-limit', async (original) => ({
  ...(await original<typeof import('@/lib/rate-limit')>()),
  withinLimit: vi.fn(),
}))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/env', async (original) => ({
  ...(await original<typeof import('@/lib/env')>()),
  requirePaymentEnv: () => ({ webhookHash: 'the-hash', testMode: true }),
}))

const { POST } = await import('@/app/api/webhooks/flutterwave/route')

const TX_REF = 'MDH-2f1c1a3e-8d7b-4c55-9a0e-1f2d3c4b5a69'

function orders(result: { data: unknown; error?: unknown }) {
  const eq = vi.fn(() => ({ maybeSingle: async () => ({ error: null, ...result }) }))
  vi.mocked(createServiceClient).mockReturnValue({
    from: () => ({ select: () => ({ eq }) }),
  } as never)
  return eq
}

function post(body: unknown, hash = 'the-hash') {
  return POST(
    new NextRequest('https://mydomainshub.test/api/webhooks/flutterwave', {
      method: 'POST',
      headers: { 'verif-hash': hash, 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
}

const charge = { event: 'charge.completed', data: { id: 4242, tx_ref: TX_REF } }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(withinLimit).mockResolvedValue(true)
})

describe('the Flutterwave webhook (SEC-7)', () => {
  it('refuses a sender without the secret hash, before reading anything', async () => {
    const response = await post(charge, 'not-the-hash')
    expect(response.status).toBe(401)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('settles the order the reference names, by the transaction id', async () => {
    const eq = orders({ data: { id: 'order-1' } })
    vi.mocked(finalizePayment).mockResolvedValue('paid')
    const response = await post(charge)
    expect(response.status).toBe(200)
    expect(eq).toHaveBeenCalledWith('tx_ref', TX_REF)
    expect(finalizePayment).toHaveBeenCalledWith('order-1', '4242')
  })

  it('asks Flutterwave to send it again when the payment could not be settled', async () => {
    orders({ data: { id: 'order-1' } })
    vi.mocked(finalizePayment).mockResolvedValue('unverified')
    expect((await post(charge)).status).toBe(503)
  })

  it('asks again when the order itself could not be looked up', async () => {
    orders({ data: null, error: { message: 'fetch failed' } })
    expect((await post(charge)).status).toBe(503)
    expect(finalizePayment).not.toHaveBeenCalled()
  })

  it.each(['mismatch', 'pending', 'failed', 'underpaid'] as const)(
    'answers 200 once the outcome is known (%s): a retry would change nothing',
    async (outcome) => {
      orders({ data: { id: 'order-1' } })
      vi.mocked(finalizePayment).mockResolvedValue(outcome)
      expect((await post(charge)).status).toBe(200)
    },
  )

  it('ignores an order it does not know', async () => {
    orders({ data: null })
    const response = await post(charge)
    expect(response.status).toBe(200)
    expect(finalizePayment).not.toHaveBeenCalled()
  })

  it.each([
    ['another event', { event: 'transfer.completed', data: { id: 1, tx_ref: TX_REF } }],
    ['an id that is not a number', { ...charge, data: { id: '../balances', tx_ref: TX_REF } }],
    ['a reference with odd characters', { ...charge, data: { id: 1, tx_ref: "x' or 1=1" } }],
    ['not JSON at all', '{nope'],
  ])('ignores %s without touching the database', async (_, body) => {
    const response = await post(body)
    expect(response.status).toBe(200)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('refuses an oversized body', async () => {
    const response = await post({ ...charge, padding: 'x'.repeat(70 * 1024) })
    expect(response.status).toBe(413)
  })

  it('past a rate limit answers 429 so Flutterwave retries later', async () => {
    vi.mocked(withinLimit).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const response = await post(charge)
    expect(response.status).toBe(429)
    expect(withinLimit).toHaveBeenCalledWith(`webhook:flutterwave:${TX_REF}`, expect.anything())
    expect(finalizePayment).not.toHaveBeenCalled()
  })
})
