import { describe, expect, it, vi } from 'vitest'
import { type JsonResponse, NoAnswer } from '../lib/http'
import { createFlutterwave, parseCharge, parseRefund, refundState } from './flutterwave'

const KEY = 'FLWSECK_TEST-abc123-X'

function withAnswer(answer: JsonResponse | Error) {
  const request = vi.fn(async (_url: string, _init?: unknown) => {
    if (answer instanceof Error) throw answer
    return answer
  })
  return {
    request,
    flutterwave: createFlutterwave({ secretKey: KEY, baseUrl: 'https://flw.test/v3', request }),
  }
}

const REFUND = {
  id: 75923,
  tx_id: 908790,
  amount_refunded: 196.725,
  status: 'completed',
  meta: { source: 'availablebalance' },
  created_at: '2026-09-24T09:18:37.366Z',
}

describe('refundState', () => {
  const at = (status: string, disburseStatus: string | null = null) =>
    refundState({
      id: '1',
      transactionId: null,
      amountKobo: 1,
      status,
      disburseStatus,
      createdAt: null,
    })

  it('treats a bare "completed" as initiated, not done', () => {
    expect(at('completed')).toBe('pending')
  })

  it.each(['completed-mpgs', 'completed-bank-transfer', 'completed-momo', 'completed-offline'])(
    'counts %s as done',
    (status) => {
      expect(at(status)).toBe('done')
    },
  )

  it('trusts a failed disbursement over a completed status', () => {
    expect(at('completed', 'failed')).toBe('failed')
  })

  it('counts a successful disbursement as done', () => {
    expect(at('completed', 'completed')).toBe('done')
  })

  it('keeps anything it does not recognise pending', () => {
    expect(at('processing')).toBe('pending')
    expect(at('pending-momo')).toBe('pending')
    expect(at('something-new')).toBe('pending')
  })
})

describe('parseRefund', () => {
  it('reads the create answer, in naira, into kobo', () => {
    expect(parseRefund(REFUND)).toEqual({
      id: '75923',
      transactionId: '908790',
      amountKobo: 19_673,
      status: 'completed',
      disburseStatus: null,
      createdAt: '2026-09-24T09:18:37.366Z',
    })
  })

  it('reads meta when Flutterwave sends it as a JSON string', () => {
    const refund = parseRefund({ ...REFUND, meta: '{"disburse_status":"failed"}' })
    expect(refund?.disburseStatus).toBe('failed')
  })

  it('reads the webhook spelling', () => {
    expect(
      parseRefund({ id: 9, AmountRefunded: 100, status: 'completed', createdAt: 'x' })?.amountKobo,
    ).toBe(10_000)
  })

  it('refuses something that is not a refund', () => {
    expect(parseRefund(null)).toBeNull()
    expect(parseRefund({ status: 'completed' })).toBeNull()
    expect(parseRefund({ id: 1, amount_refunded: 'lots' })).toBeNull()
  })
})

describe('createRefund', () => {
  it('asks for a whole refund by leaving the amount out', async () => {
    const { request, flutterwave } = withAnswer({
      status: 200,
      body: { status: 'success', data: REFUND },
    })
    await flutterwave.createRefund('908790', null)
    expect(request).toHaveBeenCalledWith(
      'https://flw.test/v3/transactions/908790/refund',
      expect.objectContaining({ method: 'POST', body: {} }),
    )
  })

  it('asks for a part refund in naira', async () => {
    const { request, flutterwave } = withAnswer({
      status: 200,
      body: { status: 'success', data: REFUND },
    })
    await flutterwave.createRefund('908790', 1_967_250)
    expect(request).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: { amount: 19_672.5 } }),
    )
  })

  it('sends the key as a bearer header, never in the URL', async () => {
    const { request, flutterwave } = withAnswer({
      status: 200,
      body: { status: 'success', data: REFUND },
    })
    await flutterwave.createRefund('908790', null)
    const [url, init] = request.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ]
    expect(url).not.toContain(KEY)
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`)
  })

  it('returns the refund when Flutterwave accepts it', async () => {
    const { flutterwave } = withAnswer({ status: 200, body: { status: 'success', data: REFUND } })
    const result = await flutterwave.createRefund('908790', null)
    expect(result).toMatchObject({ kind: 'ok', data: { id: '75923', status: 'completed' } })
  })

  it('treats a 4xx as a refusal, keeping only the short message', async () => {
    const { flutterwave } = withAnswer({
      status: 400,
      body: { status: 'error', message: 'Amount should be above NGN100', data: { email: 'a@b.c' } },
    })
    expect(await flutterwave.createRefund('908790', 5_000)).toEqual({
      kind: 'rejected',
      code: 'FLW_HTTP_400',
      message: 'Amount should be above NGN100',
    })
  })

  it.each([429, 500, 503])('treats HTTP %i as unknown — it may have landed', async (status) => {
    const { flutterwave } = withAnswer({ status, body: { message: 'An error occurred' } })
    expect((await flutterwave.createRefund('908790', null)).kind).toBe('unknown')
  })

  it('treats no answer as unknown', async () => {
    const { flutterwave } = withAnswer(new NoAnswer('timeout'))
    expect(await flutterwave.createRefund('908790', null)).toMatchObject({
      kind: 'unknown',
      code: 'FLW_NO_ANSWER',
    })
  })

  it('treats any other failure to call as unknown too', async () => {
    const { flutterwave } = withAnswer(new Error('boom'))
    expect(await flutterwave.createRefund('908790', null)).toMatchObject({
      kind: 'unknown',
      code: 'FLW_ERROR',
    })
  })

  it('treats a 200 with an error envelope as a refusal', async () => {
    const { flutterwave } = withAnswer({ status: 200, body: { status: 'error', message: 'No' } })
    expect((await flutterwave.createRefund('908790', null)).kind).toBe('rejected')
  })

  it('treats a 200 it cannot read as unknown, not success', async () => {
    const { flutterwave } = withAnswer({ status: 200, body: { status: 'success', data: {} } })
    expect((await flutterwave.createRefund('908790', null)).kind).toBe('unknown')
  })

  it('escapes the transaction id in the path', async () => {
    const { request, flutterwave } = withAnswer({
      status: 200,
      body: { status: 'success', data: REFUND },
    })
    await flutterwave.createRefund('1/../../balances', null)
    expect(request.mock.calls[0]?.[0]).toBe(
      'https://flw.test/v3/transactions/1%2F..%2F..%2Fbalances/refund',
    )
  })
})

describe('reading refunds back', () => {
  it('lists the refunds on one charge, dated to cover it', async () => {
    const { request, flutterwave } = withAnswer({
      status: 200,
      body: { status: 'success', data: [REFUND], meta: { page_info: { total_pages: 1 } } },
    })
    const result = await flutterwave.listRefunds(
      '908790',
      new Date('2026-09-22T10:00:00Z'),
      new Date('2026-09-25T10:00:00Z'),
    )
    expect(request.mock.calls[0]?.[0]).toBe(
      'https://flw.test/v3/refunds?id=908790&from=2026-09-22&to=2026-09-25',
    )
    expect(result).toMatchObject({
      kind: 'ok',
      data: { complete: true, refunds: [{ id: '75923' }] },
    })
  })

  it('keeps only refunds on this charge, should Flutterwave ignore the filter', async () => {
    // The account is shared: another app's refund must never count as ours.
    const { flutterwave } = withAnswer({
      status: 200,
      body: {
        status: 'success',
        data: [REFUND, { ...REFUND, id: 1, tx_id: 555 }, { ...REFUND, id: 2, tx_id: undefined }],
      },
    })
    const result = await flutterwave.listRefunds('908790', new Date(), new Date())
    expect(result.kind === 'ok' && result.data.refunds.map((refund) => refund.id)).toEqual([
      '75923',
      '2',
    ])
  })

  it('says when the list runs past one page', async () => {
    const { flutterwave } = withAnswer({
      status: 200,
      body: { status: 'success', data: [REFUND], meta: { page_info: { total_pages: 2 } } },
    })
    const result = await flutterwave.listRefunds('908790', new Date(), new Date())
    expect(result).toMatchObject({ kind: 'ok', data: { complete: false } })
  })

  it('will not read a list with a row it cannot parse', async () => {
    const { flutterwave } = withAnswer({
      status: 200,
      body: { status: 'success', data: [REFUND, {}] },
    })
    expect((await flutterwave.listRefunds('908790', new Date(), new Date())).kind).toBe('unknown')
  })

  it('reads a single refund whether or not it is wrapped', async () => {
    const wrapped = withAnswer({ status: 200, body: { status: 'success', data: REFUND } })
    const bare = withAnswer({ status: 200, body: { ...REFUND, status: 'completed-mpgs' } })
    expect(await wrapped.flutterwave.getRefund('75923')).toMatchObject({ kind: 'ok' })
    expect(await bare.flutterwave.getRefund('75923')).toMatchObject({
      kind: 'ok',
      data: { status: 'completed-mpgs' },
    })
  })

  it('counts the disputes on a charge', async () => {
    const { request, flutterwave } = withAnswer({
      status: 200,
      body: { status: 'success', data: [{ id: 1, status: 'initiated' }] },
    })
    expect(await flutterwave.chargebackCount('FLW-MOCK-123')).toEqual({ kind: 'ok', data: 1 })
    expect(request.mock.calls[0]?.[0]).toBe('https://flw.test/v3/chargebacks?flw_ref=FLW-MOCK-123')
  })

  it('reads the available naira balance', async () => {
    const { flutterwave } = withAnswer({
      status: 200,
      body: {
        status: 'success',
        data: { currency: 'NGN', available_balance: 25000.5, ledger_balance: 0 },
      },
    })
    expect(await flutterwave.availableBalanceKobo()).toEqual({ kind: 'ok', data: 2_500_050 })
  })
})

const CHARGE = {
  id: 908790,
  tx_ref: 'MDH-2f1c1a3e-8d7b-4c55-9a0e-1f2d3c4b5a69',
  flw_ref: 'FLW-MOCK-908790',
  amount: 39_345,
  charged_amount: 39_898.83,
  currency: 'NGN',
  status: 'successful',
  customer: { email: 'ada@example.com' },
}

describe('parseCharge', () => {
  it('reads what a verify answer says about the charge, in kobo', () => {
    expect(parseCharge(CHARGE)).toMatchObject({
      id: '908790',
      txRef: CHARGE.tx_ref,
      flwRef: 'FLW-MOCK-908790',
      status: 'successful',
      currency: 'NGN',
      amountKobo: 3_934_500,
    })
  })

  it('refuses a charge it cannot read', () => {
    expect(parseCharge(null)).toBeNull()
    expect(parseCharge({ ...CHARGE, id: undefined })).toBeNull()
    expect(parseCharge({ ...CHARGE, tx_ref: 7 })).toBeNull()
    expect(parseCharge({ ...CHARGE, amount: '39345' })).toBeNull()
  })
})

describe('verifyTransaction', () => {
  it('reads the charge by its id', async () => {
    const { request, flutterwave } = withAnswer({
      status: 200,
      body: { status: 'success', data: CHARGE },
    })
    expect(await flutterwave.verifyTransaction('908790')).toMatchObject({
      kind: 'ok',
      data: { id: '908790', amountKobo: 3_934_500 },
    })
    expect(request.mock.calls[0]?.[0]).toBe('https://flw.test/v3/transactions/908790/verify')
  })

  it('never puts anything but digits into the path', async () => {
    const { request, flutterwave } = withAnswer({ status: 200, body: {} })
    expect((await flutterwave.verifyTransaction('../balances')).kind).toBe('rejected')
    expect(request).not.toHaveBeenCalled()
  })

  it('does not believe an answer about another charge', async () => {
    const { flutterwave } = withAnswer({
      status: 200,
      body: { status: 'success', data: { ...CHARGE, id: 1 } },
    })
    expect((await flutterwave.verifyTransaction('908790')).kind).toBe('unknown')
  })

  it('reads "no such transaction" as a refusal', async () => {
    const { flutterwave } = withAnswer({
      status: 400,
      body: { status: 'error', message: 'No transaction was found for this id' },
    })
    expect((await flutterwave.verifyTransaction('908790')).kind).toBe('rejected')
  })
})

describe('verifyByReference', () => {
  it('finds the charge made against one of our references', async () => {
    const { request, flutterwave } = withAnswer({
      status: 200,
      body: { status: 'success', data: CHARGE },
    })
    expect(await flutterwave.verifyByReference(CHARGE.tx_ref)).toMatchObject({
      kind: 'ok',
      data: { id: '908790', txRef: CHARGE.tx_ref },
    })
    expect(request.mock.calls[0]?.[0]).toBe(
      `https://flw.test/v3/transactions/verify_by_reference?tx_ref=${CHARGE.tx_ref}`,
    )
  })

  it('reads "no transaction" as nothing paid yet', async () => {
    const { flutterwave } = withAnswer({
      status: 400,
      body: { status: 'error', message: 'No transaction was found for this id' },
    })
    expect(await flutterwave.verifyByReference(CHARGE.tx_ref)).toEqual({ kind: 'ok', data: null })
  })

  it('does not believe an answer about another reference', async () => {
    const { flutterwave } = withAnswer({
      status: 200,
      body: { status: 'success', data: { ...CHARGE, tx_ref: 'MDH-other' } },
    })
    expect((await flutterwave.verifyByReference(CHARGE.tx_ref)).kind).toBe('unknown')
  })

  it('keeps an outage unknown, not "nothing paid"', async () => {
    const { flutterwave } = withAnswer({ status: 503, body: { message: 'busy' } })
    expect((await flutterwave.verifyByReference(CHARGE.tx_ref)).kind).toBe('unknown')
  })
})
