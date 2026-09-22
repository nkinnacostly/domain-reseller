import { HttpResponse, http } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { server } from '../../../../tests/mocks/server'

vi.mock('@/lib/env', () => ({
  env: {
    FLUTTERWAVE_API_URL: 'https://flw.test/v3',
    NEXT_PUBLIC_APP_NAME: 'Naijadomains',
    LOG_LEVEL: 'silent',
  },
  requirePaymentEnv: () => ({ secretKey: 'FLWSECK_TEST-abc-X', testMode: true }),
}))

const { createPaymentLink, verifyTransaction, webhookHashMatches } = await import(
  '@/lib/flutterwave'
)

describe('createPaymentLink', () => {
  it('asks for the order total in naira, with our reference and return address', async () => {
    let sent: Record<string, unknown> = {}
    let auth = ''
    server.use(
      http.post('https://flw.test/v3/payments', async ({ request }) => {
        auth = request.headers.get('authorization') ?? ''
        sent = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({
          status: 'success',
          data: { link: 'https://checkout.test/pay/1' },
        })
      }),
    )

    const link = await createPaymentLink({
      txRef: 'ord_1',
      amountKobo: 1_978_000,
      redirectUrl: 'https://naija.test/app/checkout/complete?order=1',
      customer: { email: 'ada@example.com', name: 'Ada Okafor', phone: '+2348031234567' },
      orderNumber: 'ND-001001',
    })

    expect(link).toBe('https://checkout.test/pay/1')
    expect(auth).toBe('Bearer FLWSECK_TEST-abc-X')
    expect(sent).toMatchObject({
      tx_ref: 'ord_1',
      amount: 19_780,
      currency: 'NGN',
      redirect_url: 'https://naija.test/app/checkout/complete?order=1',
      customer: { email: 'ada@example.com', name: 'Ada Okafor', phonenumber: '+2348031234567' },
    })
  })

  it('fails loudly when Flutterwave refuses, so no order is left pretending', async () => {
    server.use(
      http.post('https://flw.test/v3/payments', () =>
        HttpResponse.json({ status: 'error', message: 'Invalid key' }, { status: 401 }),
      ),
    )
    await expect(
      createPaymentLink({
        txRef: 'ord_1',
        amountKobo: 100,
        redirectUrl: 'https://naija.test',
        customer: { email: 'a@b.co', name: 'A' },
        orderNumber: 'ND-1',
      }),
    ).rejects.toThrow()
  })
})

describe('verifyTransaction', () => {
  it('re-reads the transaction from the API', async () => {
    server.use(
      http.get('https://flw.test/v3/transactions/:id/verify', ({ params }) =>
        HttpResponse.json({
          status: 'success',
          data: {
            id: Number(params.id),
            tx_ref: 'ord_1',
            status: 'successful',
            amount: 19780,
            currency: 'NGN',
          },
        }),
      ),
    )
    expect(await verifyTransaction('4242')).toMatchObject({ id: 4242, status: 'successful' })
  })

  it('never puts a browser-supplied id into the path unless it is a number', async () => {
    expect(await verifyTransaction('../../balances')).toBeNull()
  })

  it('treats an unknown transaction as nothing to verify', async () => {
    server.use(
      http.get('https://flw.test/v3/transactions/:id/verify', () =>
        HttpResponse.json({ status: 'error', message: 'No transaction' }, { status: 404 }),
      ),
    )
    expect(await verifyTransaction('1')).toBeNull()
  })
})

describe('webhookHashMatches', () => {
  it('accepts only the exact secret hash', () => {
    expect(webhookHashMatches('secret-hash', 'secret-hash')).toBe(true)
    expect(webhookHashMatches('secret-hasH', 'secret-hash')).toBe(false)
    expect(webhookHashMatches('short', 'secret-hash')).toBe(false)
    expect(webhookHashMatches(null, 'secret-hash')).toBe(false)
  })
})
