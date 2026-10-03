import type { AdminFlwRefundCheck } from '@dr/shared/admin'
import { describe, expect, it } from 'vitest'
import {
  CHECK_FRESH_MS,
  checkProblems,
  incidentsHref,
  isOwedIncident,
  orderNumberQuery,
  outcomesFor,
  parseIncidentParams,
  parseReasons,
  providerWasCalled,
  queryText,
  type RefundFacts,
  refundOffers,
  toggled,
  watDayEnd,
  watDayStart,
} from '@/features/admin/lib/refunds-rules'

/**
 * Which buttons a refund offers (ADMIN-SPEC §5.2 B3: by status, playbook and
 * role), and when a Flutterwave check may back a record (D23). Failure paths
 * first: these are what keep a person from a button that would send money
 * twice or call money returned that was not.
 */

const OWNER = { role: 'owner' as const, testOnly: false }
const OPERATOR = { role: 'operator' as const, testOnly: false }
const VIEWER = { role: 'viewer' as const, testOnly: false }
const TEST_ADMIN = { role: 'operator' as const, testOnly: true }

const refund = (overrides: Partial<RefundFacts> = {}): RefundFacts => ({
  status: 'held',
  lastErrorCode: 'OVER_SINGLE_LIMIT',
  providerCalledAt: null,
  providerRefundId: null,
  ...overrides,
})

const NONE = { approve: false, retry: false, cancel: false, record: false }

describe('refundOffers: what never shows', () => {
  it('offers a viewer nothing at all', () => {
    for (const status of ['held', 'failed', 'needs_attention', 'cancelled', 'queued']) {
      expect(refundOffers(refund({ status }), VIEWER), status).toEqual(NONE)
    }
  })

  it('never shows Cancel to an operator or a test administrator', () => {
    for (const admin of [OPERATOR, TEST_ADMIN]) {
      expect(refundOffers(refund({ status: 'held' }), admin).cancel).toBe(false)
      expect(
        refundOffers(refund({ status: 'failed', lastErrorCode: 'CHARGE_NOT_OURS' }), admin),
      ).toEqual(NONE)
    }
  })

  it('never offers to send or record a refund the playbook says not to', () => {
    // Not provably this order's charge: only a cancel, by the owner, once understood.
    for (const code of ['CHARGE_NOT_OURS', 'CHARGE_NOT_FOUND', 'CHARGEBACK_ON_CHARGE']) {
      const offers = refundOffers(refund({ status: 'failed', lastErrorCode: code }), OWNER)
      expect(offers, code).toEqual({ ...NONE, cancel: true })
    }
  })

  it('offers no money button for a code with no playbook entry', () => {
    expect(
      refundOffers(refund({ status: 'needs_attention', lastErrorCode: 'SOMETHING_NEW' }), OPERATOR),
    ).toEqual(NONE)
  })

  it('does not cancel a refund Flutterwave holds, unless it bounced (no money moved)', () => {
    const atProvider = refund({
      status: 'needs_attention',
      lastErrorCode: 'REFUND_OUTCOME_UNKNOWN',
      providerCalledAt: '2026-10-03T09:00:00Z',
      providerRefundId: 'r-1',
    })
    expect(refundOffers(atProvider, OWNER).cancel).toBe(false)
    const bounced = refund({
      status: 'failed',
      lastErrorCode: 'PROVIDER_REFUND_FAILED',
      providerRefundId: 'r-1',
    })
    expect(refundOffers(bounced, OWNER).cancel).toBe(true)
  })

  it('offers nothing but Cancel (owner) on the way or done', () => {
    expect(refundOffers(refund({ status: 'queued', lastErrorCode: null }), OWNER)).toEqual({
      ...NONE,
      cancel: true,
    })
    for (const status of ['sending', 'submitted', 'completed']) {
      expect(refundOffers(refund({ status, lastErrorCode: null }), OWNER), status).toEqual(NONE)
    }
  })

  it('retries or records a cancelled refund for the owner only', () => {
    const cancelled = refund({ status: 'cancelled', lastErrorCode: 'CHARGE_NOT_OURS' })
    expect(refundOffers(cancelled, OPERATOR)).toEqual(NONE)
    expect(refundOffers(cancelled, OWNER)).toEqual({ ...NONE, retry: true, record: true })
  })
})

describe('refundOffers: what the playbook offers', () => {
  it('approves a held refund, for an operator or a test administrator too', () => {
    for (const admin of [OPERATOR, TEST_ADMIN, OWNER]) {
      expect(refundOffers(refund(), admin).approve).toBe(true)
    }
    expect(refundOffers(refund({ lastErrorCode: 'OVER_DAILY_LIMIT' }), OPERATOR)).toEqual({
      ...NONE,
      approve: true,
    })
  })

  it('offers retry and record when the outcome of a send is unknown', () => {
    expect(
      refundOffers(
        refund({ status: 'needs_attention', lastErrorCode: 'REFUND_OUTCOME_UNKNOWN' }),
        OPERATOR,
      ),
    ).toEqual({ ...NONE, retry: true, record: true })
  })

  it('offers retry after a Flutterwave refusal or a bounce', () => {
    for (const code of ['FLW_HTTP_400', 'PROVIDER_REFUND_FAILED']) {
      expect(
        refundOffers(refund({ status: 'failed', lastErrorCode: code }), OPERATOR),
        code,
      ).toEqual({ ...NONE, retry: true })
    }
  })

  it('knows Flutterwave was called from either fact', () => {
    expect(providerWasCalled(refund())).toBe(false)
    expect(providerWasCalled(refund({ providerCalledAt: '2026-10-03T09:00:00Z' }))).toBe(true)
    expect(providerWasCalled(refund({ providerRefundId: 'r-1' }))).toBe(true)
  })
})

describe('checkProblems: a check backs a record only when it matches (D23)', () => {
  const now = Date.parse('2026-10-03T09:10:00Z')
  const check: AdminFlwRefundCheck = {
    checkId: 7,
    flwRefundId: '123',
    transactionId: '456',
    amountKobo: 1_967_250,
    status: 'completed-mpgs',
    state: 'done',
    readAt: '2026-10-03T09:00:00.000Z',
  }

  it('refuses a refund Flutterwave has not finished, or that failed', () => {
    expect(checkProblems({ ...check, state: 'pending' }, { amountKobo: 1_967_250 }, now)).toEqual([
      { kind: 'state', state: 'pending', status: 'completed-mpgs' },
    ])
    expect(
      checkProblems({ ...check, state: 'failed' }, { amountKobo: 1_967_250 }, now).map(
        (p) => p.kind,
      ),
    ).toEqual(['state'])
  })

  it('refuses another amount, to the kobo', () => {
    expect(checkProblems(check, { amountKobo: 1_967_200 }, now)).toEqual([
      { kind: 'amount', checkKobo: 1_967_250, wantKobo: 1_967_200 },
    ])
  })

  it('refuses another charge, a missing one, or an incident with no charge of its own', () => {
    expect(checkProblems(check, { transactionId: '999' }, now)).toEqual([
      { kind: 'charge', checkTx: '456', wantTx: '999' },
    ])
    expect(
      checkProblems({ ...check, transactionId: null }, { transactionId: '456' }, now).map(
        (p) => p.kind,
      ),
    ).toEqual(['charge'])
    expect(checkProblems(check, { transactionId: null }, now).map((p) => p.kind)).toEqual([
      'charge',
    ])
  })

  it('refuses a check 15 minutes old, or one with no time', () => {
    const at = Date.parse(check.readAt)
    expect(checkProblems(check, { amountKobo: 1_967_250 }, at + CHECK_FRESH_MS)).toEqual([
      { kind: 'stale' },
    ])
    expect(checkProblems({ ...check, readAt: 'soon' }, {}, now)).toEqual([{ kind: 'stale' }])
  })

  it('passes a completed, fresh check for this amount and this charge', () => {
    expect(checkProblems(check, { amountKobo: 1_967_250 }, now)).toEqual([])
    expect(checkProblems(check, { transactionId: '456' }, now)).toEqual([])
    expect(
      checkProblems(
        check,
        { amountKobo: 1_967_250 },
        Date.parse(check.readAt) + CHECK_FRESH_MS - 1,
      ),
    ).toEqual([])
  })
})

describe('incidents', () => {
  it('knows which kinds owe money', () => {
    for (const kind of [
      'unrecorded_payment',
      'refund_not_created',
      'currency_mismatch',
      'mode_mismatch',
    ]) {
      expect(isOwedIncident(kind), kind).toBe(true)
    }
    for (const kind of ['underpayment', 'tx_ref_mismatch', 'registered_after_refund', '']) {
      expect(isOwedIncident(kind), kind).toBe(false)
    }
  })

  it('offers a recorded payment only for an unrecorded one, and outside handling only to the owner', () => {
    expect(outcomesFor('unrecorded_payment', OPERATOR)).toEqual([
      'payment_recorded',
      'refund_completed',
      'flw_refund_verified',
    ])
    expect(outcomesFor('currency_mismatch', OWNER)).toEqual([
      'refund_completed',
      'flw_refund_verified',
      'handled_outside',
    ])
    expect(outcomesFor('currency_mismatch', { role: 'owner', testOnly: true })).not.toContain(
      'handled_outside',
    )
  })

  it('reads the list URL strictly: open, newest first, by default', () => {
    expect(parseIncidentParams({})).toEqual({
      state: 'open',
      kinds: [],
      dir: 'desc',
      page: 1,
      per: 25,
    })
    expect(
      parseIncidentParams({
        state: 'resolved',
        kind: ['mode_mismatch,nope', 'underpayment'],
        dir: 'asc',
        page: '3',
        per: '50',
      }),
    ).toEqual({
      state: 'resolved',
      kinds: ['mode_mismatch', 'underpayment'],
      dir: 'asc',
      page: 3,
      per: 50,
    })
    expect(parseIncidentParams({ state: 'everything', page: '-1', per: '7' })).toMatchObject({
      state: 'open',
      page: 1,
      per: 25,
    })
  })

  it('builds links with defaults left out, back to page 1 when a filter changes', () => {
    const params = parseIncidentParams({ state: 'all', page: '4' })
    expect(incidentsHref(params)).toBe('/admin/refunds/incidents?state=all')
    expect(incidentsHref(params, { page: 5 })).toBe('/admin/refunds/incidents?state=all&page=5')
    expect(incidentsHref(params, { state: 'open', kinds: ['underpayment'] })).toBe(
      '/admin/refunds/incidents?kind=underpayment',
    )
    expect(incidentsHref(parseIncidentParams({}), { dir: 'asc', per: 100 })).toBe(
      '/admin/refunds/incidents?dir=asc&per=100',
    )
  })
})

describe('the refunds list URL', () => {
  it('takes an order number and nothing else as a search (N13)', () => {
    expect(orderNumberQuery('ND-001234')).toBe('ND-001234')
    expect(orderNumberQuery(' nd-1234 ')).toBe('ND-001234')
    expect(orderNumberQuery('1001')).toBe('ND-001001')
    expect(orderNumberQuery('nd1001')).toBe('ND-001001')
    expect(orderNumberQuery('someone@example.com')).toBeNull()
    expect(orderNumberQuery('example.com')).toBeNull()
    expect(orderNumberQuery('')).toBeNull()
    expect(orderNumberQuery(undefined)).toBeNull()
    expect(queryText({ q: ['  ND-1  ', 'x'] })).toBe('ND-1')
    expect(queryText({})).toBe('')
  })

  it('keeps only reasons the database has', () => {
    expect(parseReasons({ reason: 'overpayment,nope,ssl_failed' })).toEqual([
      'overpayment',
      'ssl_failed',
    ])
    expect(parseReasons({ reason: ['overpayment', 'overpayment'] })).toEqual(['overpayment'])
    expect(parseReasons({})).toEqual([])
  })

  it('toggles a filter value', () => {
    expect(toggled(['a', 'b'], 'a')).toEqual(['b'])
    expect(toggled(['b'], 'a')).toEqual(['b', 'a'])
  })

  it('filters created dates by the Lagos day', () => {
    expect(watDayStart('2026-10-03')).toBe('2026-10-03T00:00:00+01:00')
    expect(watDayEnd('2026-10-03')).toBe('2026-10-04T00:00:00+01:00')
    expect(watDayEnd('2026-12-31')).toBe('2027-01-01T00:00:00+01:00')
  })
})
