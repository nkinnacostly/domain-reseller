import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Flutterwave,
  FlutterwaveCharge,
  FlutterwaveRefund,
  FlutterwaveResult,
} from '../payments/flutterwave'
import type { Lookup } from '../provisioning/registrar'
import { createRefunder, pollDelay, retryDelay } from './refunder'
import type { ClaimedRefund, RefundStore } from './store'

/**
 * Every path a refund can take, against fakes. What matters in each: whether
 * money is asked for, how much, and what is recorded — above all, that no
 * path sends a refund twice or sends one that a check should have stopped.
 */

const NOW = new Date('2026-09-24T12:00:00Z')
const W = 'test-worker'
const TX_REF = 'MDH-2f1c1a3e-8d7b-4c55-9a0e-1f2d3c4b5a69'

function claimed(overrides: Partial<ClaimedRefund> = {}): ClaimedRefund {
  return {
    id: 'refund-1',
    action: 'send',
    reason: 'registration_failed',
    amountKobo: 1_967_250,
    attempts: 1,
    testMode: true,
    providerRefundId: null,
    providerCalledAt: null,
    submittedAt: null,
    transactionId: '908790',
    flwRef: 'FLW-MOCK-908790',
    chargedKobo: 3_934_500,
    chargedAt: '2026-09-24T11:00:00Z',
    orderTxRef: TX_REF,
    orderNumber: 'ND-001050',
    domainName: 'getpaid.com',
    heldByOtherAccount: false,
    knownProviderRefundIds: [],
    otherRefundsKobo: 0,
    ...overrides,
  }
}

const refundAt = (overrides: Partial<FlutterwaveRefund> = {}): FlutterwaveRefund => ({
  id: '75923',
  transactionId: '908790',
  amountKobo: 1_967_250,
  status: 'completed',
  disburseStatus: null,
  createdAt: NOW.toISOString(),
  ...overrides,
})

/** The charge as Flutterwave reports it: ours, unless a test says otherwise. */
const chargeAt = (overrides: Partial<FlutterwaveCharge> = {}): FlutterwaveCharge => ({
  id: '908790',
  txRef: TX_REF,
  flwRef: 'FLW-MOCK-908790',
  status: 'successful',
  currency: 'NGN',
  amountKobo: 3_934_500,
  raw: {},
  ...overrides,
})

const ok = <T>(data: T): FlutterwaveResult<T> => ({ kind: 'ok', data })
const unknown = { kind: 'unknown', code: 'FLW_NO_ANSWER', message: 'timeout' } as const

function setup(refund: ClaimedRefund | null, options: { lookup?: Lookup } = {}) {
  const calls: string[] = []
  const store = {
    claim: vi.fn(async () => refund),
    noteProviderCall: vi.fn(async () => {
      calls.push('note')
    }),
    submitted: vi.fn(async () => {
      calls.push('submitted')
    }),
    complete: vi.fn(async () => {
      calls.push('complete')
    }),
    fail: vi.fn(async () => {
      calls.push('fail')
    }),
    reschedule: vi.fn(async () => {
      calls.push('reschedule')
    }),
  } satisfies RefundStore

  const flutterwave = {
    createRefund: vi.fn(async (): Promise<FlutterwaveResult<FlutterwaveRefund>> => {
      calls.push('create')
      return ok(refundAt())
    }),
    listRefunds: vi.fn(async () => ok({ refunds: [] as FlutterwaveRefund[], complete: true })),
    getRefund: vi.fn(async (): Promise<FlutterwaveResult<FlutterwaveRefund>> => ok(refundAt())),
    chargebackCount: vi.fn(async (): Promise<FlutterwaveResult<number>> => ok(0)),
    availableBalanceKobo: vi.fn(async (): Promise<FlutterwaveResult<number>> => ok(100_000_000)),
    verifyTransaction: vi.fn(
      async (): Promise<FlutterwaveResult<FlutterwaveCharge>> => ok(chargeAt()),
    ),
    verifyByReference: vi.fn(
      async (): Promise<FlutterwaveResult<FlutterwaveCharge | null>> => ok(null),
    ),
  } satisfies Flutterwave

  const lookup = vi.fn(async (): Promise<Lookup> => options.lookup ?? { kind: 'not_found' })
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

  const refunder = createRefunder({
    store,
    flutterwave,
    lookup,
    testMode: true,
    workerId: 'test-worker',
    pollMs: 10,
    log,
    maxAttempts: 4,
    now: () => NOW,
  })
  return { refunder, store, flutterwave, lookup, log, calls }
}

beforeEach(() => vi.clearAllMocks())

describe('sending a refund', () => {
  it('refunds a failed line once every check passes, noting the call first', async () => {
    const { refunder, store, flutterwave, calls } = setup(claimed())
    await refunder.tick()
    expect(flutterwave.createRefund).toHaveBeenCalledWith('908790', 1_967_250)
    // The note is written before the request leaves, so a crash in between is readable.
    expect(calls).toEqual(['note', 'create', 'submitted'])
    expect(store.submitted).toHaveBeenCalledWith('refund-1', W, '75923', 'completed', 600)
  })

  it('asks for the whole charge when the refund is all of it', async () => {
    const whole = claimed({ reason: 'duplicate_charge', amountKobo: 3_934_500, domainName: null })
    const { refunder, flutterwave } = setup(whole)
    await refunder.tick()
    expect(flutterwave.createRefund).toHaveBeenCalledWith('908790', null)
  })

  it('asks for an amount when an earlier refund took part of the charge', async () => {
    const rest = claimed({ amountKobo: 1_967_250, otherRefundsKobo: 1_967_250 })
    const { refunder, flutterwave } = setup(rest)
    await refunder.tick()
    expect(flutterwave.createRefund).toHaveBeenCalledWith('908790', 1_967_250)
  })

  it('does not read the registry for a duplicate charge', async () => {
    const duplicate = claimed({ reason: 'duplicate_charge', domainName: null })
    const { refunder, lookup, flutterwave } = setup(duplicate)
    await refunder.tick()
    expect(lookup).not.toHaveBeenCalled()
    expect(flutterwave.createRefund).toHaveBeenCalled()
  })

  it('completes at once when Flutterwave reports the money returned', async () => {
    const { refunder, store, flutterwave } = setup(claimed())
    flutterwave.createRefund.mockResolvedValueOnce(ok(refundAt({ status: 'completed-mpgs' })))
    await refunder.tick()
    expect(store.complete).toHaveBeenCalledWith('refund-1', W, '75923', 'completed-mpgs')
  })

  it('fails for a person when Flutterwave reports the disbursement failed', async () => {
    const { refunder, store, flutterwave } = setup(claimed())
    flutterwave.createRefund.mockResolvedValueOnce(ok(refundAt({ disburseStatus: 'failed' })))
    await refunder.tick()
    expect(store.fail).toHaveBeenCalledWith(
      'refund-1',
      W,
      'PROVIDER_REFUND_FAILED',
      expect.any(String),
      false,
    )
  })

  it('records a refusal as failed, not something to retry', async () => {
    const { refunder, store, flutterwave } = setup(claimed())
    flutterwave.createRefund.mockResolvedValueOnce({
      kind: 'rejected',
      code: 'FLW_HTTP_400',
      message: 'Insufficient balance',
    })
    await refunder.tick()
    expect(store.fail).toHaveBeenCalledWith(
      'refund-1',
      W,
      'FLW_HTTP_400',
      'Insufficient balance',
      false,
    )
    expect(store.reschedule).not.toHaveBeenCalled()
  })

  it('keeps an unanswered refund in flight, to be read back — never sent again blind (I2)', async () => {
    const { refunder, store, flutterwave } = setup(claimed())
    flutterwave.createRefund.mockResolvedValueOnce(unknown)
    await refunder.tick()
    expect(store.reschedule).toHaveBeenCalledWith(
      'refund-1',
      W,
      300,
      'FLW_NO_ANSWER',
      'timeout',
      true,
    )
    expect(flutterwave.createRefund).toHaveBeenCalledTimes(1)
  })

  it('keeps the reference but stops for a person when a different amount went back', async () => {
    const { refunder, store, flutterwave, calls } = setup(claimed())
    flutterwave.createRefund.mockResolvedValueOnce(ok(refundAt({ amountKobo: 1_967_200 })))
    await refunder.tick()
    expect(flutterwave.createRefund).toHaveBeenCalledTimes(1)
    // One call: the reference and the stop land together, or not at all.
    // (The stubbed answer replaces the fake that logs 'create'.)
    expect(calls).toEqual(['note', 'fail'])
    expect(store.fail).toHaveBeenCalledWith(
      'refund-1',
      W,
      'AMOUNT_MISMATCH',
      expect.any(String),
      true,
      '75923',
    )
  })

  it('names itself on every call, so a claim that passed to another worker is refused', async () => {
    const { refunder, store } = setup(claimed())
    await refunder.tick()
    expect(store.noteProviderCall).toHaveBeenCalledWith('refund-1', W)
    expect(store.submitted).toHaveBeenCalledWith('refund-1', W, '75923', 'completed', 600)
  })
})

describe('the charge a refund goes back to (shared Flutterwave account)', () => {
  it('reads the charge back from Flutterwave before anything else is asked', async () => {
    const { refunder, flutterwave, lookup } = setup(claimed())
    await refunder.tick()
    expect(flutterwave.verifyTransaction).toHaveBeenCalledWith('908790')
    expect(flutterwave.verifyTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      lookup.mock.invocationCallOrder[0] ?? 0,
    )
  })

  it.each([
    ['another reference — another app’s customer', { txRef: 'PAIDLY-123' }],
    ['another of our orders', { txRef: 'MDH-00000000-0000-0000-0000-000000000000' }],
    ['another currency', { currency: 'USD' }],
    ['another amount', { amountKobo: 3_934_400 }],
    ['a failed charge', { status: 'failed' }],
    ['a charge still pending', { status: 'pending' }],
  ])('never refunds a charge with %s', async (_, overrides) => {
    const { refunder, store, flutterwave } = setup(claimed())
    flutterwave.verifyTransaction.mockResolvedValueOnce(ok(chargeAt(overrides)))
    await refunder.tick()
    expect(store.fail).toHaveBeenCalledWith(
      'refund-1',
      W,
      'CHARGE_NOT_OURS',
      expect.any(String),
      true,
    )
    expect(flutterwave.createRefund).not.toHaveBeenCalled()
  })

  it('never refunds for an order that is not one of ours', async () => {
    const { refunder, store, flutterwave } = setup(claimed({ orderTxRef: 'PAIDLY-123' }))
    flutterwave.verifyTransaction.mockResolvedValueOnce(ok(chargeAt({ txRef: 'PAIDLY-123' })))
    await refunder.tick()
    expect(store.fail).toHaveBeenCalledWith(
      'refund-1',
      W,
      'CHARGE_NOT_OURS',
      expect.any(String),
      true,
    )
    expect(flutterwave.createRefund).not.toHaveBeenCalled()
  })

  it('stops when Flutterwave has no such charge for this key', async () => {
    const { refunder, store, flutterwave } = setup(claimed())
    flutterwave.verifyTransaction.mockResolvedValueOnce({
      kind: 'rejected',
      code: 'FLW_HTTP_400',
      message: 'No transaction',
    })
    await refunder.tick()
    expect(store.fail).toHaveBeenCalledWith(
      'refund-1',
      W,
      'CHARGE_NOT_FOUND',
      expect.any(String),
      true,
    )
    expect(flutterwave.createRefund).not.toHaveBeenCalled()
  })

  it('waits when the charge cannot be read', async () => {
    const { refunder, store, flutterwave } = setup(claimed())
    flutterwave.verifyTransaction.mockResolvedValueOnce(unknown)
    await refunder.tick()
    expect(store.reschedule).toHaveBeenCalledWith(
      'refund-1',
      W,
      300,
      'FLW_NO_ANSWER',
      expect.any(String),
      false,
    )
    expect(flutterwave.createRefund).not.toHaveBeenCalled()
  })

  it('checks disputes by the reference Flutterwave returned, not our copy', async () => {
    const { refunder, flutterwave } = setup(claimed({ flwRef: null }))
    flutterwave.verifyTransaction.mockResolvedValueOnce(ok(chargeAt({ flwRef: 'FLW-FRESH' })))
    await refunder.tick()
    expect(flutterwave.chargebackCount).toHaveBeenCalledWith('FLW-FRESH')
    expect(flutterwave.createRefund).toHaveBeenCalled()
  })

  it('never sends one that already has a Flutterwave reference', async () => {
    const { refunder, store, flutterwave } = setup(claimed({ providerRefundId: '75923' }))
    await refunder.tick()
    expect(store.fail).toHaveBeenCalledWith(
      'refund-1',
      W,
      'ALREADY_AT_PROVIDER',
      expect.any(String),
      true,
    )
    expect(flutterwave.createRefund).not.toHaveBeenCalled()
  })
})

describe('checks that stop a refund before money moves', () => {
  it('refuses anything under Flutterwave’s ₦100 minimum', async () => {
    const { refunder, store, flutterwave } = setup(claimed({ amountKobo: 9_999 }))
    await refunder.tick()
    expect(store.fail).toHaveBeenCalledWith(
      'refund-1',
      W,
      'BELOW_PROVIDER_MINIMUM',
      expect.any(String),
      true,
    )
    expect(flutterwave.createRefund).not.toHaveBeenCalled()
  })

  it('refuses a refund that would take more than the charge', async () => {
    const { refunder, store, flutterwave } = setup(claimed({ otherRefundsKobo: 3_000_000 }))
    await refunder.tick()
    expect(store.fail).toHaveBeenCalledWith(
      'refund-1',
      W,
      'EXCEEDS_CHARGE',
      expect.any(String),
      true,
    )
    expect(flutterwave.createRefund).not.toHaveBeenCalled()
  })

  it('refunds a line that lost the name to another account here, though the registry has it', async () => {
    const { refunder, flutterwave } = setup(claimed({ heldByOtherAccount: true }), {
      lookup: {
        kind: 'found',
        domain: {
          registeredAt: null,
          expiresAt: null,
          nameservers: [],
          transferLock: true,
          privacy: false,
        },
      },
    })
    await refunder.tick()
    expect(flutterwave.createRefund).toHaveBeenCalledWith('908790', 1_967_250)
  })

  it('never refunds a domain the registry says we hold', async () => {
    const { refunder, store, flutterwave } = setup(claimed(), {
      lookup: {
        kind: 'found',
        domain: {
          registeredAt: null,
          expiresAt: null,
          nameservers: [],
          transferLock: true,
          privacy: false,
        },
      },
    })
    await refunder.tick()
    expect(store.fail).toHaveBeenCalledWith(
      'refund-1',
      W,
      'REGISTERED_AT_REGISTRY',
      expect.any(String),
      true,
    )
    expect(flutterwave.createRefund).not.toHaveBeenCalled()
  })

  it('waits when the registry cannot be read', async () => {
    const { refunder, store, flutterwave } = setup(claimed(), {
      lookup: { kind: 'unknown', code: 'TIMEOUT', message: 'slow' },
    })
    await refunder.tick()
    expect(store.reschedule).toHaveBeenCalledWith(
      'refund-1',
      W,
      300,
      'REGISTRY_UNREADABLE',
      expect.any(String),
      false,
    )
    expect(flutterwave.createRefund).not.toHaveBeenCalled()
  })

  it('hands to a person once retries of an unreadable check run out', async () => {
    const { refunder, store } = setup(claimed({ attempts: 4 }), {
      lookup: { kind: 'unknown', code: 'TIMEOUT', message: 'slow' },
    })
    await refunder.tick()
    expect(store.fail).toHaveBeenCalledWith(
      'refund-1',
      W,
      'REGISTRY_UNREADABLE',
      expect.any(String),
      true,
    )
    expect(store.reschedule).not.toHaveBeenCalled()
  })

  it('never refunds a disputed charge — that can pay the customer twice', async () => {
    const { refunder, store, flutterwave } = setup(claimed())
    flutterwave.chargebackCount.mockResolvedValueOnce(ok(1))
    await refunder.tick()
    expect(store.fail).toHaveBeenCalledWith(
      'refund-1',
      W,
      'CHARGEBACK_ON_CHARGE',
      expect.any(String),
      true,
    )
    expect(flutterwave.createRefund).not.toHaveBeenCalled()
  })

  it('waits when disputes cannot be checked', async () => {
    const { refunder, store, flutterwave } = setup(claimed())
    flutterwave.chargebackCount.mockResolvedValueOnce(unknown)
    await refunder.tick()
    expect(store.reschedule).toHaveBeenCalledWith(
      'refund-1',
      W,
      300,
      'FLW_NO_ANSWER',
      expect.any(String),
      false,
    )
    expect(flutterwave.createRefund).not.toHaveBeenCalled()
  })

  it('stops when the charge has no reference to check disputes against', async () => {
    const { refunder, store, flutterwave } = setup(claimed({ flwRef: null }))
    flutterwave.verifyTransaction.mockResolvedValueOnce(ok(chargeAt({ flwRef: null })))
    await refunder.tick()
    expect(store.fail).toHaveBeenCalledWith(
      'refund-1',
      W,
      'NO_PROVIDER_REFERENCE',
      expect.any(String),
      true,
    )
    expect(flutterwave.createRefund).not.toHaveBeenCalled()
  })

  it('waits when Flutterwave’s refunds cannot be read', async () => {
    const { refunder, store, flutterwave } = setup(claimed())
    flutterwave.listRefunds.mockResolvedValueOnce(unknown)
    await refunder.tick()
    expect(store.reschedule).toHaveBeenCalledWith(
      'refund-1',
      W,
      300,
      'FLW_NO_ANSWER',
      expect.any(String),
      false,
    )
    expect(flutterwave.createRefund).not.toHaveBeenCalled()
  })

  it('stops when the list runs past a page', async () => {
    const { refunder, store, flutterwave } = setup(claimed())
    flutterwave.listRefunds.mockResolvedValueOnce(ok({ refunds: [], complete: false }))
    await refunder.tick()
    expect(store.fail).toHaveBeenCalledWith(
      'refund-1',
      W,
      'TOO_MANY_PROVIDER_REFUNDS',
      expect.any(String),
      true,
    )
  })

  it('never adopts a refund on a fresh send — one it did not make goes to a person', async () => {
    const { refunder, store, flutterwave } = setup(claimed())
    flutterwave.listRefunds.mockResolvedValueOnce(ok({ refunds: [refundAt()], complete: true }))
    await refunder.tick()
    expect(flutterwave.createRefund).not.toHaveBeenCalled()
    expect(store.submitted).not.toHaveBeenCalled()
    expect(store.fail).toHaveBeenCalledWith(
      'refund-1',
      W,
      'UNTRACKED_REFUND_AT_PROVIDER',
      expect.any(String),
      true,
    )
  })

  it('sends again after a person retries one Flutterwave reported failed', async () => {
    // retry_refund keeps the failed reference in known_provider_refund_ids.
    const { refunder, flutterwave } = setup(claimed({ knownProviderRefundIds: ['75923'] }))
    flutterwave.listRefunds.mockResolvedValueOnce(
      ok({ refunds: [refundAt({ disburseStatus: 'failed' })], complete: true }),
    )
    await refunder.tick()
    expect(flutterwave.createRefund).toHaveBeenCalledWith('908790', 1_967_250)
  })

  it('stops when Flutterwave holds refunds we do not account for', async () => {
    const { refunder, store, flutterwave } = setup(claimed())
    flutterwave.listRefunds.mockResolvedValueOnce(
      ok({ refunds: [refundAt({ amountKobo: 500_000 })], complete: true }),
    )
    await refunder.tick()
    expect(store.fail).toHaveBeenCalledWith(
      'refund-1',
      W,
      'UNTRACKED_REFUND_AT_PROVIDER',
      expect.any(String),
      true,
    )
    expect(flutterwave.createRefund).not.toHaveBeenCalled()
  })

  it('ignores refunds that our other rows account for, and failed ones', async () => {
    const { refunder, flutterwave } = setup(
      claimed({ knownProviderRefundIds: ['111'], otherRefundsKobo: 1_967_250 }),
    )
    flutterwave.listRefunds.mockResolvedValueOnce(
      ok({
        refunds: [
          refundAt({ id: '111', amountKobo: 1_967_250 }),
          refundAt({ id: '222', amountKobo: 900_000, disburseStatus: 'failed' }),
        ],
        complete: true,
      }),
    )
    await refunder.tick()
    expect(flutterwave.createRefund).toHaveBeenCalledWith('908790', 1_967_250)
  })

  it('stops when Flutterwave has already refunded too much of the charge', async () => {
    const { refunder, store, flutterwave } = setup(
      claimed({ knownProviderRefundIds: ['111'], otherRefundsKobo: 1_000_000 }),
    )
    flutterwave.listRefunds.mockResolvedValueOnce(
      ok({ refunds: [refundAt({ id: '111', amountKobo: 3_000_000 })], complete: true }),
    )
    await refunder.tick()
    expect(store.fail).toHaveBeenCalledWith(
      'refund-1',
      W,
      'EXCEEDS_CHARGE_AT_PROVIDER',
      expect.any(String),
      true,
    )
    expect(flutterwave.createRefund).not.toHaveBeenCalled()
  })

  it('waits half an hour when our Flutterwave balance cannot cover it', async () => {
    const { refunder, store, flutterwave } = setup(claimed())
    flutterwave.availableBalanceKobo.mockResolvedValueOnce(ok(1_000_000))
    await refunder.tick()
    expect(store.reschedule).toHaveBeenCalledWith(
      'refund-1',
      W,
      1800,
      'INSUFFICIENT_BALANCE',
      expect.any(String),
      false,
    )
    expect(flutterwave.createRefund).not.toHaveBeenCalled()
  })

  it('still sends when the balance cannot be read — Flutterwave refuses what it cannot cover', async () => {
    const { refunder, flutterwave } = setup(claimed())
    flutterwave.availableBalanceKobo.mockResolvedValueOnce(unknown)
    await refunder.tick()
    expect(flutterwave.createRefund).toHaveBeenCalled()
  })
})

describe('recovering a refund whose worker stopped mid-send', () => {
  it('sends again when the last attempt never called Flutterwave', async () => {
    const { refunder, store, flutterwave } = setup(
      claimed({ action: 'recover', providerCalledAt: null }),
    )
    await refunder.tick()
    expect(store.reschedule).toHaveBeenCalledWith(
      'refund-1',
      W,
      0,
      'RESUMED',
      expect.any(String),
      false,
    )
    expect(flutterwave.listRefunds).not.toHaveBeenCalled()
    expect(flutterwave.createRefund).not.toHaveBeenCalled()
  })

  it('adopts the refund it finds rather than sending again', async () => {
    const { refunder, store, flutterwave } = setup(
      claimed({ action: 'recover', providerCalledAt: NOW.toISOString() }),
    )
    flutterwave.listRefunds.mockResolvedValueOnce(
      ok({ refunds: [refundAt({ status: 'completed-mpgs' })], complete: true }),
    )
    await refunder.tick()
    expect(store.complete).toHaveBeenCalledWith('refund-1', W, '75923', 'completed-mpgs')
    expect(flutterwave.createRefund).not.toHaveBeenCalled()
  })

  it('reads again later when nothing is listed yet', async () => {
    const { refunder, store, flutterwave } = setup(
      claimed({ action: 'recover', providerCalledAt: NOW.toISOString(), attempts: 2 }),
    )
    await refunder.tick()
    expect(store.reschedule).toHaveBeenCalledWith(
      'refund-1',
      W,
      900,
      'NOT_LISTED_YET',
      'Reading back',
      true,
    )
    expect(flutterwave.createRefund).not.toHaveBeenCalled()
  })

  it('hands to a person when it never appears', async () => {
    const { refunder, store, flutterwave } = setup(
      claimed({ action: 'recover', providerCalledAt: NOW.toISOString(), attempts: 4 }),
    )
    await refunder.tick()
    expect(store.fail).toHaveBeenCalledWith(
      'refund-1',
      W,
      'REFUND_OUTCOME_UNKNOWN',
      expect.any(String),
      true,
    )
    expect(flutterwave.createRefund).not.toHaveBeenCalled()
  })

  it('stops when the refund it finds is for a different amount', async () => {
    const { refunder, store, flutterwave } = setup(
      claimed({ action: 'recover', providerCalledAt: NOW.toISOString() }),
    )
    flutterwave.listRefunds.mockResolvedValueOnce(
      ok({ refunds: [refundAt({ amountKobo: 100_000 })], complete: true }),
    )
    await refunder.tick()
    expect(store.fail).toHaveBeenCalledWith(
      'refund-1',
      W,
      'UNTRACKED_REFUND_AT_PROVIDER',
      expect.any(String),
      true,
    )
    expect(flutterwave.createRefund).not.toHaveBeenCalled()
  })

  it('never adopts a refund that does not name our charge', async () => {
    const { refunder, store, flutterwave } = setup(
      claimed({ action: 'recover', providerCalledAt: NOW.toISOString() }),
    )
    flutterwave.listRefunds.mockResolvedValueOnce(
      ok({ refunds: [refundAt({ transactionId: null })], complete: true }),
    )
    await refunder.tick()
    expect(store.complete).not.toHaveBeenCalled()
    expect(store.submitted).not.toHaveBeenCalled()
    expect(store.fail).toHaveBeenCalledWith(
      'refund-1',
      W,
      'UNTRACKED_REFUND_AT_PROVIDER',
      expect.any(String),
      true,
    )
  })

  it('stops when it finds two candidates, even of the right amount', async () => {
    const { refunder, store, flutterwave } = setup(
      claimed({ action: 'recover', providerCalledAt: NOW.toISOString() }),
    )
    flutterwave.listRefunds.mockResolvedValueOnce(
      ok({ refunds: [refundAt({ id: '1' }), refundAt({ id: '2' })], complete: true }),
    )
    await refunder.tick()
    expect(store.fail).toHaveBeenCalledWith(
      'refund-1',
      W,
      'UNTRACKED_REFUND_AT_PROVIDER',
      expect.any(String),
      true,
    )
  })
})

describe('following a refund Flutterwave has accepted', () => {
  const submitted = (overrides: Partial<ClaimedRefund> = {}) =>
    claimed({
      action: 'poll',
      providerRefundId: '75923',
      submittedAt: '2026-09-24T11:30:00Z',
      ...overrides,
    })

  it('completes it once the money has gone back', async () => {
    const { refunder, store, flutterwave } = setup(submitted())
    flutterwave.getRefund.mockResolvedValueOnce(ok(refundAt({ status: 'completed-bank-transfer' })))
    await refunder.tick()
    expect(store.complete).toHaveBeenCalledWith('refund-1', W, '75923', 'completed-bank-transfer')
  })

  it('asks again later while it is still pending', async () => {
    const { refunder, store } = setup(submitted())
    await refunder.tick()
    expect(store.reschedule).toHaveBeenCalledWith(
      'refund-1',
      W,
      600,
      'AWAITING_PROVIDER',
      'Flutterwave status completed',
      true,
    )
  })

  it('fails it for a person when the disbursement fails', async () => {
    const { refunder, store, flutterwave } = setup(submitted())
    flutterwave.getRefund.mockResolvedValueOnce(ok(refundAt({ disburseStatus: 'failed' })))
    await refunder.tick()
    expect(store.fail).toHaveBeenCalledWith(
      'refund-1',
      W,
      'PROVIDER_REFUND_FAILED',
      expect.any(String),
      false,
    )
  })

  it('keeps waiting when Flutterwave cannot be reached', async () => {
    const { refunder, store, flutterwave } = setup(submitted())
    flutterwave.getRefund.mockResolvedValueOnce(unknown)
    await refunder.tick()
    expect(store.reschedule).toHaveBeenCalledWith(
      'refund-1',
      W,
      600,
      'FLW_NO_ANSWER',
      'timeout',
      true,
    )
  })

  it('stops when it has no Flutterwave reference to ask about', async () => {
    const { refunder, store } = setup(submitted({ providerRefundId: null }))
    await refunder.tick()
    expect(store.fail).toHaveBeenCalledWith(
      'refund-1',
      W,
      'NO_PROVIDER_REFUND_ID',
      expect.any(String),
      true,
    )
  })
})

describe('the worker loop', () => {
  it('reports an empty queue', async () => {
    const { refunder } = setup(null)
    expect(await refunder.tick()).toBe(false)
  })

  it('refuses a refund for the other side, and leaves it for its lease (N12)', async () => {
    const { refunder, flutterwave, log } = setup(claimed({ testMode: false }))
    expect(await refunder.tick()).toBe(true)
    expect(flutterwave.createRefund).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ refundId: 'refund-1' }),
      expect.any(String),
    )
  })

  it('logs a crash and moves on, leaving the refund in flight', async () => {
    const { refunder, store, log } = setup(claimed())
    store.noteProviderCall.mockRejectedValueOnce(new Error('db down'))
    expect(await refunder.tick()).toBe(true)
    expect(log.error).toHaveBeenCalled()
  })

  it('starts and stops cleanly', async () => {
    const { refunder } = setup(null)
    refunder.start()
    refunder.start()
    await refunder.stop()
  })
})

describe('timing', () => {
  it('backs off between checks that cannot be made', () => {
    expect([1, 2, 3, 4, 9].map(retryDelay)).toEqual([300, 900, 1800, 3600, 3600])
  })

  it('asks about accepted refunds less often as they age', () => {
    expect(pollDelay('2026-09-24T11:30:00Z', NOW)).toBe(600)
    expect(pollDelay('2026-09-24T06:00:00Z', NOW)).toBe(3600)
    expect(pollDelay('2026-09-20T06:00:00Z', NOW)).toBe(21_600)
  })
})
