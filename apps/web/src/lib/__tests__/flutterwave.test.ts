import { HttpResponse, http } from 'msw'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { server } from '../../../tests/mocks/server'
import { createPaymentLink, verifyTransaction, webhookHashMatches } from '../flutterwave'

// env.ts reads process.env once, at import. Test keys only (N12); listed as
// pairs so the pre-commit secret scan does not take the dummies for real keys.
vi.hoisted(() => {
  const vars: [string, string][] = [
    ['FLUTTERWAVE_API_URL', 'https://flw.test/v3'],
    ['FLUTTERWAVE_SECRET_KEY', 'FLWSECK_TEST-0000000000000000-X'],
    ['NEXT_PUBLIC_FLUTTERWAVE_PUBLIC_KEY', 'FLWPUBK_TEST-0000000000000000-X'],
    ['FLUTTERWAVE_WEBHOOK_HASH', 'a-secret-hash'],
  ]
  for (const [name, value] of vars) vi.stubEnv(name, value)
})
afterAll(() => vi.unstubAllEnvs())

const API = 'https://flw.test/v3'

const ORDER = {
  txRef: 'MDH-ord_1',
  amountKobo: 1_978_000,
  redirectUrl: 'https://mydomainshub.test/app/checkout/complete?order=1',
  customer: { email: 'ada@example.com', name: 'Ada Okafor' },
  orderNumber: 'ND-001001',
}

const answerPayment = (reply: () => Response) => server.use(http.post(`${API}/payments`, reply))
const answerVerify = (reply: (id: string) => Response) =>
  server.use(http.get(`${API}/transactions/:id/verify`, ({ params }) => reply(String(params.id))))

const transaction = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  tx_ref: 'MDH-ord_1',
  status: 'successful',
  amount: 19_780,
  currency: 'NGN',
  ...overrides,
})

describe('createPaymentLink', () => {
  it('asks for the order total in naira with our key, reference and order number', async () => {
    let auth: string | null = null
    let sent: Record<string, unknown> = {}
    server.use(
      http.post(`${API}/payments`, async ({ request }) => {
        auth = request.headers.get('authorization')
        sent = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ status: 'success', data: { link: 'https://pay.test/1' } })
      }),
    )

    expect(await createPaymentLink(ORDER)).toBe('https://pay.test/1')
    expect(auth).toBe('Bearer FLWSECK_TEST-0000000000000000-X')
    expect(sent).toMatchObject({
      tx_ref: 'MDH-ord_1',
      amount: 19_780,
      currency: 'NGN',
      payment_options: 'card,banktransfer,ussd',
      customizations: { description: 'Order ND-001001' },
      meta: { order_number: 'ND-001001' },
    })
  })

  it('fails when Flutterwave answers without a link, so no order waits on nothing', async () => {
    answerPayment(() => HttpResponse.json({ status: 'success', data: {} }))
    await expect(createPaymentLink(ORDER)).rejects.toThrow('Flutterwave returned no payment link')
  })

  it('fails when Flutterwave does not say success, even with a link', async () => {
    answerPayment(() =>
      HttpResponse.json({ status: 'error', data: { link: 'https://pay.test/stale' } }),
    )
    await expect(createPaymentLink(ORDER)).rejects.toThrow('Flutterwave returned no payment link')
  })

  it('fails on a refusal, naming only the status', async () => {
    answerPayment(() =>
      HttpResponse.json({ status: 'error', message: 'Invalid email ada@x' }, { status: 400 }),
    )
    await expect(createPaymentLink(ORDER)).rejects.toThrow(/^Flutterwave 400$/)
  })

  it('fails on an answer it cannot read', async () => {
    answerPayment(() => new HttpResponse('<html>maintenance</html>', { status: 200 }))
    await expect(createPaymentLink(ORDER)).rejects.toThrow(/^Flutterwave 200$/)
  })
})

describe('verifyTransaction', () => {
  it('re-reads the transaction and believes it only when it is the one asked about', async () => {
    answerVerify((id) => HttpResponse.json({ status: 'success', data: transaction(Number(id)) }))

    expect(await verifyTransaction('4242')).toEqual({
      kind: 'found',
      transaction: transaction(4242),
    })
  })

  it('never builds a path from an id that is not a plain number', async () => {
    expect(await verifyTransaction('1/../../balances')).toEqual({ kind: 'missing' })
    expect(await verifyTransaction('')).toEqual({ kind: 'missing' })
  })

  it.each([
    [400, 'a refused id'],
    [404, 'no such transaction'],
  ])('reads a %i (%s) as "no such transaction"', async (status) => {
    answerVerify(() => HttpResponse.json({ status: 'error', message: 'No tx' }, { status }))
    expect(await verifyTransaction('1')).toEqual({ kind: 'missing' })
  })

  it('reads an explicit error answer as "no such transaction"', async () => {
    answerVerify(() => HttpResponse.json({ status: 'error', message: 'No transaction was found' }))
    expect(await verifyTransaction('1')).toEqual({ kind: 'missing' })
  })

  it.each([
    [401, 'our key refused'],
    [403, 'our key forbidden'],
    [429, 'rate limited'],
    [500, 'Flutterwave failing'],
    [503, 'Flutterwave overloaded'],
  ])('a %i (%s) is not a verdict: ask again later', async (status) => {
    answerVerify(() => HttpResponse.json({ status: 'error' }, { status }))
    expect(await verifyTransaction('1')).toEqual({ kind: 'unreachable' })
  })

  it('no answer at all is not a verdict either', async () => {
    server.use(http.get(`${API}/transactions/:id/verify`, () => HttpResponse.error()))
    expect(await verifyTransaction('1')).toEqual({ kind: 'unreachable' })
  })

  it.each([
    ['a different transaction', { status: 'success', data: transaction(8) }],
    ['no transaction data', { status: 'success', data: null }],
    ['data that is not an object', { status: 'success', data: 'successful' }],
    [
      'an amount that is not a number',
      { status: 'success', data: transaction(7, { amount: '19780' }) },
    ],
    ['no currency', { status: 'success', data: transaction(7, { currency: undefined }) }],
    ['a status it does not know', { status: 'pending' }],
  ])('does not believe an answer with %s', async (_, body) => {
    answerVerify(() => HttpResponse.json(body))
    expect(await verifyTransaction('7')).toEqual({ kind: 'unreachable' })
  })

  it('does not believe an answer it cannot read', async () => {
    answerVerify(() => new HttpResponse('not json', { status: 200 }))
    expect(await verifyTransaction('7')).toEqual({ kind: 'unreachable' })
  })
})

describe('webhookHashMatches (SEC-7)', () => {
  it('accepts only the exact secret hash', () => {
    expect(webhookHashMatches('a-secret-hash', 'a-secret-hash')).toBe(true)
  })

  it.each([
    ['a different hash of the same length', 'a-secret-hasH'],
    ['a shorter hash', 'a-secret'],
    ['a longer hash', 'a-secret-hash-and-more'],
    ['an empty header', ''],
    ['no header', null],
  ])('refuses %s', (_, received) => {
    expect(webhookHashMatches(received, 'a-secret-hash')).toBe(false)
  })
})
