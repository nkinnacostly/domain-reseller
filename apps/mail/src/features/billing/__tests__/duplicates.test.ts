import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServiceClient } from '@/lib/supabase/service'
import { mockRpc } from '../../../../tests/mocks/supabase'
import {
  cancelDuplicateSubscriptions,
  readDueAccounts,
  sweepDuplicateSubscriptions,
} from '../server/duplicates'
import { requireBillingEnv } from '../server/env'
import { findSubscriptions } from '../server/flutterwave'
import { handleBillingJobs } from '../server/jobs'
import {
  restartAndNote,
  restartFlutterwaveSubscription,
  stopAndNote,
  stopFlutterwaveSubscription,
  stopReplaced,
} from '../server/provider'
import { settleCharge } from '../server/settle'
import {
  cancelled,
  DUPLICATE,
  DUPLICATE_TX_REF,
  FIRST_CHARGE,
  FIRST_RENEWAL_CHARGE,
  KEPT,
  NO_SUBSCRIPTIONS,
  RENEWAL,
  SECOND_RENEWAL,
  SECOND_RENEWAL_CHARGE,
  subscriptionsOfFirstCharge,
} from './duplicate-fixtures'
import { KEY_VAR, mockFlutterwave, setBillingEnv, verified } from './flutterwave-mock'

/**
 * Duplicate Flutterwave subscriptions (MAIL-SPEC §8; migration 56), against
 * the network boundary with the live test-mode run's answers (7 Oct 2026):
 * one charge, two subscriptions, two renewals. Failure paths first: a cancel
 * Flutterwave does not confirm is never taken as done.
 */

const LIST = `GET /subscriptions?transaction_id=${FIRST_CHARGE}`
const ACCOUNT = '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e'
const TOKEN = 'f'.repeat(64)
const settings = () => requireBillingEnv()

beforeEach(() => setBillingEnv())
afterEach(() =>
  setBillingEnv({
    [KEY_VAR]: undefined,
    FLUTTERWAVE_WEBHOOK_HASH: undefined,
    FLUTTERWAVE_API_URL: undefined,
  }),
)

describe('listing a first charge’s subscriptions', () => {
  it('lists both, earliest-made first, however Flutterwave orders them', async () => {
    const calls = mockFlutterwave({ [LIST]: subscriptionsOfFirstCharge() })
    const found = await findSubscriptions(settings(), FIRST_CHARGE)
    expect(found).toEqual({
      kind: 'found',
      subscriptions: [
        { id: KEPT, status: 'active', plan: 150321, createdAt: '2026-10-07T00:54:15.000Z' },
        { id: DUPLICATE, status: 'active', plan: 150321, createdAt: '2026-10-07T00:57:09.000Z' },
      ],
    })
    expect(calls).toHaveLength(1)
  })

  it('answers missing for a charge with none, and unreachable for an answer that leaves some out', async () => {
    mockFlutterwave({ 'GET /subscriptions?transaction_id=999': NO_SUBSCRIPTIONS })
    expect(await findSubscriptions(settings(), '999')).toEqual({ kind: 'missing' })
    const more = subscriptionsOfFirstCharge()
    more.body.meta.page_info.total_pages = 2
    mockFlutterwave({ [LIST]: more })
    expect(await findSubscriptions(settings(), FIRST_CHARGE)).toEqual({ kind: 'unreachable' })
    mockFlutterwave({ [LIST]: { status: 503, body: { status: 'error' } } })
    expect(await findSubscriptions(settings(), FIRST_CHARGE)).toEqual({ kind: 'unreachable' })
  })
})

describe('stopping a plan stops every subscription of its first charge', () => {
  it('cancels the duplicate first and the plan’s own last, each confirmed', async () => {
    const calls = mockFlutterwave({
      [LIST]: subscriptionsOfFirstCharge(),
      [`PUT /subscriptions/${DUPLICATE}/cancel`]: cancelled(DUPLICATE),
      [`PUT /subscriptions/${KEPT}/cancel`]: cancelled(KEPT),
    })
    const rpc = mockRpc({ note_provider_canceled: () => ({ ok: true }) })
    expect(await stopAndNote(createServiceClient(), settings(), ACCOUNT, FIRST_CHARGE)).toBe(true)
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      LIST,
      `PUT /subscriptions/${DUPLICATE}/cancel`,
      `PUT /subscriptions/${KEPT}/cancel`,
    ])
    expect(rpc.map((call) => call.fn)).toEqual(['note_provider_canceled'])
  })

  it('stops at the first cancel Flutterwave does not confirm, leaving the plan’s own running', async () => {
    const calls = mockFlutterwave({
      [LIST]: subscriptionsOfFirstCharge(),
      [`PUT /subscriptions/${DUPLICATE}/cancel`]: { status: 504, body: { status: 'error' } },
    })
    const rpc = mockRpc({})
    expect(await stopAndNote(createServiceClient(), settings(), ACCOUNT, FIRST_CHARGE)).toBe(false)
    expect(calls.map((call) => call.path)).not.toContain(`/subscriptions/${KEPT}/cancel`)
    // Nothing noted: SQL never hears of a stop Flutterwave did not confirm.
    expect(rpc).toHaveLength(0)
  })

  it('asks only what is still running, and never takes an empty list as stopped', async () => {
    const calls = mockFlutterwave({
      [LIST]: subscriptionsOfFirstCharge({ duplicate: 'cancelled' }),
      [`PUT /subscriptions/${KEPT}/cancel`]: cancelled(KEPT),
    })
    expect(await stopFlutterwaveSubscription(settings(), FIRST_CHARGE)).toBe(true)
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1)
    mockFlutterwave({ [LIST]: NO_SUBSCRIPTIONS })
    expect(await stopFlutterwaveSubscription(settings(), FIRST_CHARGE)).toBe(false)
  })

  it('a replaced plan’s subscriptions all stop; one that will not is an incident', async () => {
    mockFlutterwave({
      [LIST]: subscriptionsOfFirstCharge(),
      [`PUT /subscriptions/${DUPLICATE}/cancel`]: cancelled(DUPLICATE),
      [`PUT /subscriptions/${KEPT}/cancel`]: { status: 500, body: {} },
    })
    const rpc = mockRpc({ record_billing_incident: () => ({ body: null }) })
    await stopReplaced(createServiceClient(), settings(), ACCOUNT, [FIRST_CHARGE])
    expect(rpc[0]?.body).toMatchObject({
      p_kind: 'subscription_not_canceled',
      p_provider_reference: FIRST_CHARGE,
      p_account_id: ACCOUNT,
    })
  })

  it('keeping the plan starts the earliest again, never the duplicate', async () => {
    const calls = mockFlutterwave({
      [LIST]: subscriptionsOfFirstCharge({ kept: 'cancelled', duplicate: 'cancelled' }),
      [`PUT /subscriptions/${KEPT}/activate`]: {
        body: { status: 'success', data: { id: KEPT, status: 'active' } },
      },
    })
    mockRpc({ note_provider_active: () => ({ ok: true }) })
    expect(await restartAndNote(createServiceClient(), settings(), ACCOUNT, FIRST_CHARGE)).toBe(
      true,
    )
    expect(calls.filter((call) => call.method === 'PUT').map((call) => call.path)).toEqual([
      `/subscriptions/${KEPT}/activate`,
    ])
    mockFlutterwave({ [LIST]: subscriptionsOfFirstCharge({ duplicate: 'cancelled' }) })
    expect(await restartFlutterwaveSubscription(settings(), FIRST_CHARGE)).toBe(true)
    mockFlutterwave({ [LIST]: NO_SUBSCRIPTIONS })
    expect(await restartFlutterwaveSubscription(settings(), FIRST_CHARGE)).toBe(false)
  })
})

describe('a duplicate subscription is cancelled', () => {
  it('keeps the earliest-made, cancels the other, and records the incident with both ids', async () => {
    const calls = mockFlutterwave({
      [LIST]: subscriptionsOfFirstCharge(),
      [`PUT /subscriptions/${DUPLICATE}/cancel`]: cancelled(DUPLICATE),
    })
    const rpc = mockRpc({ record_billing_incident: () => ({ body: null }) })
    expect(
      await cancelDuplicateSubscriptions(createServiceClient(), settings(), ACCOUNT, FIRST_CHARGE),
    ).toEqual({ kind: 'duplicates', kept: KEPT, canceled: [DUPLICATE], notCanceled: [] })
    expect(calls.filter((call) => call.method === 'PUT').map((call) => call.path)).toEqual([
      `/subscriptions/${DUPLICATE}/cancel`,
    ])
    expect(rpc[0]).toMatchObject({
      fn: 'record_billing_incident',
      schema: 'mail',
      body: {
        p_test_mode: true,
        p_kind: 'duplicate_subscription',
        p_account_id: ACCOUNT,
        p_provider_reference: FIRST_CHARGE,
        p_detail: { kept_subscription_id: '53194', duplicate_subscription_ids: '53195' },
      },
    })
  })

  it('a cancel that fails or times out is not taken as done, and the next run asks again', async () => {
    let answers = 0
    mockFlutterwave({
      [LIST]: subscriptionsOfFirstCharge(),
      [`PUT /subscriptions/${DUPLICATE}/cancel`]: () =>
        answers++ === 0 ? { status: 504, body: { status: 'error' } } : cancelled(DUPLICATE),
    })
    const rpc = mockRpc({ record_billing_incident: () => ({ body: null }) })
    const service = createServiceClient()
    expect(await cancelDuplicateSubscriptions(service, settings(), ACCOUNT, FIRST_CHARGE)).toEqual({
      kind: 'duplicates',
      kept: KEPT,
      canceled: [],
      notCanceled: [DUPLICATE],
    })
    // The next hour: listed again, and asked again.
    expect(await cancelDuplicateSubscriptions(service, settings(), ACCOUNT, FIRST_CHARGE)).toEqual({
      kind: 'duplicates',
      kept: KEPT,
      canceled: [DUPLICATE],
      notCanceled: [],
    })
    // The same incident both times: SQL keeps one open row per account and charge.
    expect(rpc.map((call) => call.body.p_provider_reference)).toEqual([FIRST_CHARGE, FIRST_CHARGE])
  })

  it('is safe to repeat: once the duplicate is stopped there is nothing to do', async () => {
    const calls = mockFlutterwave({
      [LIST]: subscriptionsOfFirstCharge({ duplicate: 'cancelled' }),
    })
    const rpc = mockRpc({})
    expect(
      await cancelDuplicateSubscriptions(createServiceClient(), settings(), ACCOUNT, FIRST_CHARGE),
    ).toEqual({ kind: 'single' })
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0)
    expect(rpc).toHaveLength(0)
    mockFlutterwave({ [LIST]: NO_SUBSCRIPTIONS })
    expect(
      await cancelDuplicateSubscriptions(createServiceClient(), settings(), ACCOUNT, FIRST_CHARGE),
    ).toEqual({ kind: 'single' })
    mockFlutterwave({ [LIST]: { status: 500, body: {} } })
    expect(
      await cancelDuplicateSubscriptions(createServiceClient(), settings(), ACCOUNT, FIRST_CHARGE),
    ).toEqual({ kind: 'unreachable' })
  })

  it('the earliest-made is kept even when a later one is listed first', async () => {
    const reversed = subscriptionsOfFirstCharge()
    reversed.body.data.reverse()
    mockFlutterwave({
      [LIST]: reversed,
      [`PUT /subscriptions/${DUPLICATE}/cancel`]: cancelled(DUPLICATE),
    })
    mockRpc({ record_billing_incident: () => ({ body: null }) })
    expect(
      await cancelDuplicateSubscriptions(createServiceClient(), settings(), null, FIRST_CHARGE),
    ).toMatchObject({ kind: 'duplicates', kept: KEPT })
  })
})

describe('settling looks for a duplicate at once', () => {
  it('after a first charge is recorded', async () => {
    const calls = mockFlutterwave({
      [`GET /transactions/${FIRST_CHARGE}/verify`]: verified(Number(FIRST_CHARGE), {
        tx_ref: DUPLICATE_TX_REF,
      }),
      [LIST]: subscriptionsOfFirstCharge(),
      [`PUT /subscriptions/${DUPLICATE}/cancel`]: cancelled(DUPLICATE),
    })
    const rpc = mockRpc({
      record_billing_charge: () => ({
        ok: true,
        outcome: 'paid',
        accountId: ACCOUNT,
        cancelTransactions: [],
      }),
      record_billing_incident: () => ({ body: null }),
    })
    expect(await settleCharge(FIRST_CHARGE)).toBe('paid')
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET /transactions/${FIRST_CHARGE}/verify`,
      LIST,
      `PUT /subscriptions/${DUPLICATE}/cancel`,
    ])
    expect(rpc[1]?.body).toMatchObject({ p_kind: 'duplicate_subscription', p_account_id: ACCOUNT })
  })

  it('after the second renewal in one month, which SQL recorded without applying', async () => {
    mockFlutterwave({
      [`GET /transactions/${RENEWAL}/verify`]: FIRST_RENEWAL_CHARGE,
      [`GET /transactions/${SECOND_RENEWAL}/verify`]: SECOND_RENEWAL_CHARGE,
      [LIST]: subscriptionsOfFirstCharge(),
      [`PUT /subscriptions/${DUPLICATE}/cancel`]: cancelled(DUPLICATE),
    })
    const rpc = mockRpc({
      record_billing_charge: (body) =>
        body.p_transaction_id === String(RENEWAL)
          ? { ok: true, outcome: 'renewed', cancelTransactions: [] }
          : {
              ok: true,
              outcome: 'unapplied',
              reason: 'duplicate_charge',
              accountId: ACCOUNT,
              firstTransactionId: FIRST_CHARGE,
              cancelTransactions: [],
            },
      record_billing_incident: () => ({ body: null }),
    })
    expect(await settleCharge(String(RENEWAL))).toBe('renewed')
    // The renewal itself looks for nothing.
    expect(rpc.map((call) => call.fn)).toEqual(['record_billing_charge'])
    expect(await settleCharge(String(SECOND_RENEWAL))).toBe('unapplied')
    expect(rpc.map((call) => call.fn)).toEqual([
      'record_billing_charge',
      'record_billing_charge',
      'record_billing_incident',
    ])
    expect(rpc[1]?.body).toMatchObject({
      p_transaction_id: String(SECOND_RENEWAL),
      p_tx_ref: DUPLICATE_TX_REF,
      p_amount_kobo: 2_150_000,
    })
    expect(rpc[2]?.body).toMatchObject({
      p_kind: 'duplicate_subscription',
      p_provider_reference: FIRST_CHARGE,
    })
  })

  it('a look that fails changes nothing about the recorded charge', async () => {
    mockFlutterwave({
      [`GET /transactions/${FIRST_CHARGE}/verify`]: verified(Number(FIRST_CHARGE)),
      [LIST]: { status: 503, body: { status: 'error' } },
    })
    // Before migration 56 the answer names no account: the redirect's is used, or none.
    const rpc = mockRpc({ record_billing_charge: () => ({ ok: true, outcome: 'paid' }) })
    expect(await settleCharge(FIRST_CHARGE, { txRef: verifiedRef(), accountId: ACCOUNT })).toBe(
      'paid',
    )
    expect(rpc.map((call) => call.fn)).toEqual(['record_billing_charge'])
    // A duplicate answer without a usable first charge looks for nothing.
    mockRpc({
      record_billing_charge: () => ({
        ok: true,
        outcome: 'unapplied',
        reason: 'duplicate_charge',
        firstTransactionId: 'x',
      }),
    })
    expect(await settleCharge(FIRST_CHARGE)).toBe('unapplied')
  })

  it('an incident SQL will not take (before migration 56) still lets the cancel go', async () => {
    const calls = mockFlutterwave({
      [`GET /transactions/${FIRST_CHARGE}/verify`]: verified(Number(FIRST_CHARGE)),
      [LIST]: subscriptionsOfFirstCharge(),
      [`PUT /subscriptions/${DUPLICATE}/cancel`]: cancelled(DUPLICATE),
    })
    // The kind's check refuses the row: recordIncident logs it, and the cancel still goes.
    mockRpc({
      record_billing_charge: () => ({ ok: true, outcome: 'paid', accountId: ACCOUNT }),
      record_billing_incident: () => ({ status: 400, body: { code: '23514' } }),
    })
    expect(await settleCharge(FIRST_CHARGE)).toBe('paid')
    expect(calls.at(-1)).toMatchObject({
      method: 'PUT',
      path: `/subscriptions/${DUPLICATE}/cancel`,
    })
  })
})

function verifiedRef() {
  return verified(1).body.data.tx_ref
}

describe('the hourly run', () => {
  it('reads SQL’s list of what to look at, and refuses what it cannot read', () => {
    expect(readDueAccounts({ ok: false, code: 'unauthorized' })).toBeNull()
    expect(readDueAccounts(null)).toBeNull()
    expect(readDueAccounts({ ok: true })).toEqual([])
    expect(
      readDueAccounts({
        ok: true,
        accounts: [
          { accountId: ACCOUNT, firstTransactionId: FIRST_CHARGE },
          { accountId: ACCOUNT, firstTransactionId: 'x' },
          { accountId: 1, firstTransactionId: '1' },
          null,
        ],
      }),
    ).toEqual([{ accountId: ACCOUNT, firstTransactionId: FIRST_CHARGE }])
  })

  it('asks SQL with the token, this key’s side and API, then looks at each account', async () => {
    mockFlutterwave({
      [LIST]: subscriptionsOfFirstCharge(),
      [`PUT /subscriptions/${DUPLICATE}/cancel`]: cancelled(DUPLICATE),
      'GET /subscriptions?transaction_id=222': NO_SUBSCRIPTIONS,
      'GET /subscriptions?transaction_id=333': { status: 502, body: {} },
    })
    const rpc = mockRpc({
      begin_billing_jobs: () => ({
        ok: true,
        accounts: [
          { accountId: ACCOUNT, firstTransactionId: FIRST_CHARGE },
          { accountId: ACCOUNT, firstTransactionId: '222' },
          { accountId: ACCOUNT, firstTransactionId: '333' },
        ],
      }),
      record_billing_incident: () => ({ body: null }),
    })
    expect(await sweepDuplicateSubscriptions(createServiceClient(), settings(), TOKEN)).toEqual({
      checked: 3,
      duplicates: 1,
      canceled: 1,
      notCanceled: 0,
      unreachable: 1,
    })
    expect(rpc[0]).toMatchObject({
      fn: 'begin_billing_jobs',
      schema: 'mail',
      body: { p_token: TOKEN, p_test_mode: true, p_api_host: 'flw.test', p_limit: 100 },
    })
  })

  it('stops starting accounts when its time is up, and counts a cancel not confirmed', async () => {
    mockFlutterwave({
      [LIST]: subscriptionsOfFirstCharge(),
      [`PUT /subscriptions/${DUPLICATE}/cancel`]: { status: 504, body: {} },
    })
    mockRpc({
      begin_billing_jobs: () => ({
        ok: true,
        accounts: [{ accountId: ACCOUNT, firstTransactionId: FIRST_CHARGE }],
      }),
      record_billing_incident: () => ({ body: null }),
    })
    expect(await sweepDuplicateSubscriptions(createServiceClient(), settings(), TOKEN)).toEqual({
      checked: 1,
      duplicates: 1,
      canceled: 0,
      notCanceled: 1,
      unreachable: 0,
    })
    let clock = 0
    const late = () => {
      clock += 60_000
      return clock
    }
    expect(
      await sweepDuplicateSubscriptions(createServiceClient(), settings(), TOKEN, late),
    ).toMatchObject({ checked: 0 })
  })

  it('answers null for a refused token, and throws when SQL cannot be asked', async () => {
    mockRpc({ begin_billing_jobs: () => ({ ok: false, code: 'unauthorized' }) })
    expect(await sweepDuplicateSubscriptions(createServiceClient(), settings(), TOKEN)).toBeNull()
    mockRpc({ begin_billing_jobs: () => ({ status: 500, body: { code: '08006' } }) })
    await expect(
      sweepDuplicateSubscriptions(createServiceClient(), settings(), TOKEN),
    ).rejects.toThrow('begin_billing_jobs failed: 08006')
  })
})

describe('POST /api/jobs/billing', () => {
  const post = (authorization?: string) =>
    handleBillingJobs(
      new Request('https://emails.test/api/jobs/billing', {
        method: 'POST',
        headers: authorization ? { authorization } : {},
        body: '{}',
      }),
    )

  it('needs a bearer token, and billing set up', async () => {
    expect((await post()).status).toBe(401)
    expect((await post('Bearer short')).status).toBe(401)
    setBillingEnv({ [KEY_VAR]: undefined })
    const response = await post(`Bearer ${TOKEN}`)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ ok: false, error: 'billing_not_configured' })
  })

  it('is refused when SQL does not know the token', async () => {
    mockRpc({ begin_billing_jobs: () => ({ ok: false, code: 'unauthorized' }) })
    const response = await post(`Bearer ${TOKEN}`)
    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('runs and answers counts only', async () => {
    mockRpc({ begin_billing_jobs: () => ({ ok: true, accounts: [] }) })
    const response = await post(`Bearer ${TOKEN}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      checked: 0,
      duplicates: 0,
      canceled: 0,
      notCanceled: 0,
      unreachable: 0,
    })
  })

  it('answers 500, saying nothing more, when the run fails', async () => {
    mockRpc({ begin_billing_jobs: () => ({ status: 500, body: { code: '08006' } }) })
    const response = await post(`Bearer ${TOKEN}`)
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ ok: false, error: 'internal_error' })
  })
})
