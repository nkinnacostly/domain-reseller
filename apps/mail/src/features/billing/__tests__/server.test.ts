import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServiceClient } from '@/lib/supabase/service'
import { mockRpc } from '../../../../tests/mocks/supabase'
import { paymentsConfigured, requireBillingEnv } from '../server/env'
import {
  createPaymentLink,
  createPaymentPlan,
  findSubscription,
  setSubscription,
  verifyTransaction,
  webhookHashMatches,
} from '../server/flutterwave'
import { ensureFlutterwavePlan } from '../server/plans'
import {
  readProviderState,
  restartAndNote,
  stopAndNote,
  stopFlutterwaveSubscription,
} from '../server/provider'
import { returnFromCheckout } from '../server/return'
import { settleCharge } from '../server/settle'
import { handleFlutterwaveWebhook } from '../server/webhook'
import {
  FLW,
  HASH,
  KEY_VAR,
  mockFlutterwave,
  setBillingEnv,
  TEST_KEY,
  verified,
} from './flutterwave-mock'

/**
 * Billing's Flutterwave side against the network boundary (MSW): what is sent
 * to Flutterwave and to SQL, that a charge is re-read before it counts
 * (SEC-7), and that a payment is never dropped — 503 until it is recorded.
 */

const TX_REF = 'MDM-11111111-2222-4333-8444-555555555555'
const settings = () => requireBillingEnv()

beforeEach(() => setBillingEnv())
afterEach(() =>
  setBillingEnv({
    [KEY_VAR]: undefined,
    FLUTTERWAVE_WEBHOOK_HASH: undefined,
    FLUTTERWAVE_API_URL: undefined,
  }),
)

describe('the payment settings (N12)', () => {
  it('needs both the key and the hash, and refuses a live key outside production', () => {
    expect(requireBillingEnv()).toMatchObject({ testMode: true, apiHost: 'flw.test', apiUrl: FLW })
    setBillingEnv({ FLUTTERWAVE_WEBHOOK_HASH: undefined })
    expect(paymentsConfigured()).toBe(false)
    expect(() => requireBillingEnv()).toThrow('Billing is not configured')
    setBillingEnv({ [KEY_VAR]: 'FLWSECK-live-key' })
    expect(() => requireBillingEnv()).toThrow('Refusing a live Flutterwave key outside production')
  })

  it('sends a live key to Flutterwave’s own API only', () => {
    const before = process.env.NODE_ENV
    Object.assign(process.env, { NODE_ENV: 'production' })
    try {
      setBillingEnv({ [KEY_VAR]: 'FLWSECK-live-key' })
      expect(() => requireBillingEnv()).toThrow('only sent to https://api.flutterwave.com/v3')
      setBillingEnv({ [KEY_VAR]: 'FLWSECK-live-key', FLUTTERWAVE_API_URL: undefined })
      expect(requireBillingEnv()).toMatchObject({ testMode: false, apiHost: 'api.flutterwave.com' })
    } finally {
      Object.assign(process.env, { NODE_ENV: before })
    }
  })
})

describe('Flutterwave calls', () => {
  it('makes a monthly plan object at the amount with VAT, in naira', async () => {
    const calls = mockFlutterwave({
      'POST /payment-plans': { body: { status: 'success', data: { id: 3807 } } },
    })
    expect(await createPaymentPlan(settings(), { name: 'Starter', amountKobo: 2_150_000 })).toBe(
      3807,
    )
    expect(calls[0]).toMatchObject({
      body: { name: 'Starter', amount: 21500, interval: 'monthly', currency: 'NGN' },
      auth: `Bearer ${TEST_KEY}`,
    })
    mockFlutterwave({ 'POST /payment-plans': { status: 500, body: { status: 'error' } } })
    expect(await createPaymentPlan(settings(), { name: 'Starter', amountKobo: 1 })).toBeNull()
  })

  it('opens a hosted checkout subscribed to the plan object', async () => {
    const calls = mockFlutterwave({
      'POST /payments': {
        body: { status: 'success', data: { link: 'https://checkout.test/pay/1' } },
      },
    })
    const link = await createPaymentLink(settings(), {
      txRef: TX_REF,
      amountKobo: 4_479_167,
      flutterwavePlanId: 3807,
      redirectUrl: 'https://emails.test/dashboard/billing/complete?checkout=1',
      customer: { email: 'ada@example.com', name: 'Ada' },
      description: 'Pro plan, monthly',
    })
    expect(link).toBe('https://checkout.test/pay/1')
    expect(calls[0]?.body).toMatchObject({ tx_ref: TX_REF, amount: 44791.67, payment_plan: 3807 })
    mockFlutterwave({
      'POST /payments': { body: { status: 'success', data: { link: 'javascript:x' } } },
    })
    expect(
      await createPaymentLink(settings(), {
        txRef: TX_REF,
        amountKobo: 1,
        flutterwavePlanId: 1,
        redirectUrl: 'https://x.test',
        customer: { email: 'a@example.com', name: 'A' },
        description: 'x',
      }),
    ).toBeNull()
  })

  it('tells a charge it found from one it is missing, and from not hearing at all', async () => {
    mockFlutterwave({ 'GET /transactions/9100001/verify': verified(9100001) })
    const found = await verifyTransaction(settings(), '9100001')
    expect(found).toMatchObject({ kind: 'found', charge: { amountKobo: 2_150_000, txRef: TX_REF } })
    expect(await verifyTransaction(settings(), 'abc')).toEqual({ kind: 'missing' })
    mockFlutterwave({ 'GET /transactions/1/verify': { status: 404, body: { status: 'error' } } })
    expect(await verifyTransaction(settings(), '1')).toEqual({ kind: 'missing' })
    mockFlutterwave({ 'GET /transactions/2/verify': { status: 503, body: { status: 'error' } } })
    expect(await verifyTransaction(settings(), '2')).toEqual({ kind: 'unreachable' })
    // An answer for another id is not an answer about this one.
    mockFlutterwave({ 'GET /transactions/3/verify': verified(4) })
    expect(await verifyTransaction(settings(), '3')).toEqual({ kind: 'unreachable' })
    mockFlutterwave({ 'GET /transactions/5/verify': { body: { status: 'error' } } })
    expect(await verifyTransaction(settings(), '5')).toEqual({ kind: 'missing' })
    mockFlutterwave({ 'GET /transactions/6/verify': { body: { status: 'odd' } } })
    expect(await verifyTransaction(settings(), '6')).toEqual({ kind: 'unreachable' })
  })

  it('finds, stops and restarts a subscription by its first charge', async () => {
    const calls = mockFlutterwave({
      'GET /subscriptions': {
        body: { status: 'success', data: [{ id: 77, status: 'active', plan: 3 }] },
      },
      'PUT /subscriptions/77/cancel': {
        body: { status: 'success', data: { id: 77, status: 'cancelled' } },
      },
      'PUT /subscriptions/77/activate': {
        body: { status: 'success', data: { id: 77, status: 'active' } },
      },
    })
    expect(await findSubscription(settings(), '9100001')).toMatchObject({
      kind: 'found',
      subscription: { id: 77 },
    })
    expect(calls[0]?.path).toBe('/subscriptions?transaction_id=9100001')
    expect(await setSubscription(settings(), 77, 'cancel')).toBe(true)
    expect(await setSubscription(settings(), 77, 'activate')).toBe(true)
    expect(await findSubscription(settings(), 'x')).toEqual({ kind: 'missing' })
    mockFlutterwave({ 'GET /subscriptions': { body: { status: 'success', data: [] } } })
    expect(await findSubscription(settings(), '1')).toEqual({ kind: 'missing' })
    mockFlutterwave({
      'GET /subscriptions': {
        body: {
          status: 'success',
          data: [
            { id: 1, status: 'active' },
            { id: 2, status: 'active' },
          ],
        },
      },
    })
    expect(await findSubscription(settings(), '1')).toEqual({ kind: 'unreachable' })
    mockFlutterwave({ 'PUT /subscriptions/9/cancel': { body: { status: 'success', data: {} } } })
    expect(await setSubscription(settings(), 9, 'cancel')).toBe(false)
  })

  it('compares the webhook hash in constant time', () => {
    expect(webhookHashMatches(HASH, HASH)).toBe(true)
    expect(webhookHashMatches('nope', HASH)).toBe(false)
    expect(webhookHashMatches(null, HASH)).toBe(false)
  })
})

describe('keeping Flutterwave in step', () => {
  it('stops only what Flutterwave confirms, and notes it', async () => {
    mockFlutterwave({
      'GET /subscriptions': { body: { status: 'success', data: [{ id: 77, status: 'active' }] } },
      'PUT /subscriptions/77/cancel': {
        body: { status: 'success', data: { status: 'cancelled' } },
      },
    })
    const rpc = mockRpc({ note_provider_canceled: () => ({ ok: true }) })
    expect(await stopAndNote(createServiceClient(), settings(), 'acc', '9100001')).toBe(true)
    expect(rpc[0]).toMatchObject({
      fn: 'note_provider_canceled',
      body: { p_account_id: 'acc', p_first_transaction_id: '9100001' },
      schema: 'mail',
    })
    // A subscription Flutterwave cannot find is never taken as stopped.
    mockFlutterwave({ 'GET /subscriptions': { body: { status: 'success', data: [] } } })
    expect(await stopFlutterwaveSubscription(settings(), '9100001')).toBe(false)
    mockFlutterwave({
      'GET /subscriptions': { body: { status: 'success', data: [{ id: 7, status: 'cancelled' }] } },
    })
    expect(await stopFlutterwaveSubscription(settings(), '9100001')).toBe(true)
  })

  it('restarts and notes, and reads the provider state', async () => {
    mockFlutterwave({
      'GET /subscriptions': {
        body: { status: 'success', data: [{ id: 77, status: 'cancelled' }] },
      },
      'PUT /subscriptions/77/activate': { body: { status: 'success', data: { status: 'active' } } },
    })
    mockRpc({
      note_provider_active: () => ({ ok: true }),
      billing_provider_state: () => ({
        ok: true,
        subscription: {
          status: 'active',
          firstTransactionId: '9',
          providerCanceled: true,
          scheduledPlanCode: 'free',
        },
      }),
    })
    const service = createServiceClient()
    expect(await restartAndNote(service, settings(), 'acc', '9')).toBe(true)
    expect(await readProviderState(service, 'acc')).toEqual({
      status: 'active',
      firstTransactionId: '9',
      providerCanceled: true,
      scheduledPlanCode: 'free',
    })
    mockRpc({ billing_provider_state: () => ({ ok: true, subscription: null }) })
    expect(await readProviderState(service, 'acc')).toBeNull()
    mockRpc({ billing_provider_state: () => ({ status: 500, body: { code: 'XX000' } }) })
    expect(await readProviderState(service, 'acc')).toBe('error')
    mockRpc({ billing_provider_state: () => ({ ok: true, subscription: { status: 'odd' } }) })
    expect(await readProviderState(service, 'acc')).toBe('error')
  })
})

describe('plan objects, on demand (N5b)', () => {
  it('uses a recorded one, or makes one at SQL’s amount and records it', async () => {
    const rpc = mockRpc({
      flutterwave_plan_for: () => ({
        ok: true,
        planName: 'Starter',
        amountKobo: 2_150_000,
        flutterwavePlanId: null,
      }),
      register_flutterwave_plan: () => ({ ok: true, flutterwavePlanId: 3807 }),
    })
    const calls = mockFlutterwave({
      'POST /payment-plans': { body: { status: 'success', data: { id: 3807 } } },
    })
    expect(await ensureFlutterwavePlan(createServiceClient(), settings(), 'starter')).toBe(3807)
    expect(rpc[0]?.body).toEqual({
      p_plan_code: 'starter',
      p_test_mode: true,
      p_api_host: 'flw.test',
    })
    expect(calls[0]?.body).toMatchObject({
      name: 'MyDomainsHub Mail Starter, monthly',
      amount: 21500,
    })
    expect(rpc[1]?.body).toMatchObject({ p_amount_kobo: 2_150_000, p_flutterwave_plan_id: 3807 })

    mockRpc({
      flutterwave_plan_for: () => ({
        ok: true,
        planName: 'Starter',
        amountKobo: 1,
        flutterwavePlanId: 12,
      }),
    })
    expect(await ensureFlutterwavePlan(createServiceClient(), settings(), 'starter')).toBe(12)
  })

  it('answers null when SQL or Flutterwave says no', async () => {
    mockRpc({ flutterwave_plan_for: () => ({ ok: false, code: 'not_offered' }) })
    expect(await ensureFlutterwavePlan(createServiceClient(), settings(), 'scale')).toBeNull()
    mockRpc({
      flutterwave_plan_for: () => ({
        ok: true,
        planName: 'Pro',
        amountKobo: 5_912_500,
        flutterwavePlanId: null,
      }),
      register_flutterwave_plan: () => ({ ok: false, code: 'amount_changed' }),
    })
    mockFlutterwave({ 'POST /payment-plans': { body: { status: 'success', data: { id: 1 } } } })
    expect(await ensureFlutterwavePlan(createServiceClient(), settings(), 'pro')).toBeNull()
    mockFlutterwave({ 'POST /payment-plans': { status: 500, body: {} } })
    expect(await ensureFlutterwavePlan(createServiceClient(), settings(), 'pro')).toBeNull()
  })
})

describe('settling a charge (SEC-7)', () => {
  it('re-reads the charge, records only the allowlisted facts, and stops what SQL names', async () => {
    mockFlutterwave({
      'GET /transactions/9100002/verify': verified(9100002, { amount: 44791.67 }),
      'GET /subscriptions': { body: { status: 'success', data: [{ id: 5, status: 'active' }] } },
      'PUT /subscriptions/5/cancel': { body: { status: 'success', data: { status: 'cancelled' } } },
    })
    const rpc = mockRpc({
      record_billing_charge: () => ({ ok: true, outcome: 'paid', cancelTransactions: ['9100001'] }),
    })
    expect(await settleCharge('9100002', { txRef: TX_REF, accountId: 'acc' })).toBe('paid')
    const sent = rpc[0]?.body ?? {}
    expect(sent).toMatchObject({
      p_test_mode: true,
      p_transaction_id: '9100002',
      p_tx_ref: TX_REF,
      p_status: 'successful',
      p_amount_kobo: 4_479_167,
      p_currency: 'NGN',
      p_card_last4: '4242',
      p_card_brand: 'VISA',
    })
    expect(JSON.stringify(sent.p_raw)).not.toMatch(/someone|t1nk/)
  })

  it('records an incident when a replaced subscription cannot be stopped', async () => {
    mockFlutterwave({
      'GET /transactions/9100002/verify': verified(9100002),
      'GET /subscriptions': { status: 503, body: { status: 'error' } },
    })
    const rpc = mockRpc({
      record_billing_charge: () => ({ ok: true, outcome: 'paid', cancelTransactions: ['9100001'] }),
      record_billing_incident: () => ({ body: null }),
    })
    expect(await settleCharge('9100002')).toBe('paid')
    expect(rpc[1]).toMatchObject({
      fn: 'record_billing_incident',
      body: {
        p_kind: 'subscription_not_canceled',
        p_provider_reference: '9100001',
        p_account_id: null,
      },
    })
  })

  it('a charge for another checkout is a mismatch and an incident; another app’s is not ours', async () => {
    mockFlutterwave({ 'GET /transactions/9100003/verify': verified(9100003) })
    const rpc = mockRpc({ record_billing_incident: () => ({ body: null }) })
    expect(await settleCharge('9100003', { txRef: 'MDM-other', accountId: 'acc' })).toBe('mismatch')
    expect(rpc[0]).toMatchObject({ body: { p_kind: 'tx_ref_mismatch', p_account_id: 'acc' } })
    mockFlutterwave({
      'GET /transactions/9100004/verify': verified(9100004, { tx_ref: 'MDH-shop' }),
    })
    expect(await settleCharge('9100004')).toBe('not_ours')
  })

  it('is unverified — and never dropped — when Flutterwave or SQL cannot answer', async () => {
    mockFlutterwave({ 'GET /transactions/9100005/verify': { status: 502, body: {} } })
    expect(await settleCharge('9100005')).toBe('unverified')
    mockFlutterwave({ 'GET /transactions/9100006/verify': verified(9100006) })
    const rpc = mockRpc({
      record_billing_charge: () => ({ status: 500, body: { code: '08006' } }),
      record_billing_incident: () => ({ body: null }),
    })
    expect(await settleCharge('9100006')).toBe('unverified')
    expect(rpc[1]?.body).toMatchObject({
      p_kind: 'unrecorded_payment',
      p_provider_reference: '9100006',
    })
    mockFlutterwave({
      'GET /transactions/9100007/verify': { status: 404, body: { status: 'error' } },
    })
    expect(await settleCharge('9100007')).toBe('missing')
  })

  it('passes SQL’s outcome through, loudly when a person must look', async () => {
    mockFlutterwave({ 'GET /transactions/9100008/verify': verified(9100008) })
    mockRpc({
      record_billing_charge: () => ({ ok: true, outcome: 'unapplied', reason: 'checkout_expired' }),
    })
    expect(await settleCharge('9100008')).toBe('unapplied')
    mockRpc({ record_billing_charge: () => ({ ok: true, outcome: 'odd' }) })
    expect(await settleCharge('9100008')).toBe('unverified')
  })
})

describe('the webhook (via Paidly)', () => {
  const body = JSON.stringify({ event: 'charge.completed', data: { id: 9100009, tx_ref: TX_REF } })

  it('refuses a wrong hash, and asks again while billing is not set up', async () => {
    expect((await handleFlutterwaveWebhook('wrong', body)).status).toBe(401)
    setBillingEnv({ [KEY_VAR]: undefined })
    expect((await handleFlutterwaveWebhook(HASH, body)).status).toBe(503)
  })

  it('ignores what is not one of our charges, and refuses a huge body', async () => {
    expect(
      await handleFlutterwaveWebhook(HASH, '{"event":"subscription.cancelled","data":{}}'),
    ).toEqual({
      status: 200,
      body: { ok: true, ignored: true },
    })
    expect((await handleFlutterwaveWebhook(HASH, 'not json')).body).toMatchObject({ ignored: true })
    expect(
      (
        await handleFlutterwaveWebhook(
          HASH,
          JSON.stringify({ event: 'charge.completed', data: { id: 1, tx_ref: 'MDH-1' } }),
        )
      ).body,
    ).toMatchObject({ ignored: true })
    expect((await handleFlutterwaveWebhook(HASH, 'x'.repeat(70_000))).status).toBe(413)
  })

  it('settles a charge (200), and asks for it again when it could not (503)', async () => {
    mockFlutterwave({ 'GET /transactions/9100009/verify': verified(9100009, { status: 'failed' }) })
    mockRpc({ record_billing_charge: () => ({ ok: true, outcome: 'renewal_failed' }) })
    expect(await handleFlutterwaveWebhook(HASH, body)).toEqual({ status: 200, body: { ok: true } })
    mockFlutterwave({ 'GET /transactions/9100009/verify': { status: 500, body: {} } })
    expect((await handleFlutterwaveWebhook(HASH, body)).status).toBe(503)
  })
})

describe('the return from Flutterwave’s checkout', () => {
  const checkout = { id: 'c', accountId: 'acc', txRef: TX_REF, status: 'open' }

  it('decides nothing from the query string', async () => {
    expect(await returnFromCheckout(null, { status: 'successful', transactionId: '1' })).toBeNull()
    expect(await returnFromCheckout(checkout, { status: 'cancelled', transactionId: null })).toBe(
      'cancelled',
    )
    expect(await returnFromCheckout(checkout, { status: 'successful', transactionId: null })).toBe(
      'pending',
    )
    expect(await returnFromCheckout(checkout, { status: 'successful', transactionId: 'x1' })).toBe(
      'pending',
    )
  })

  it('settles the charge the redirect names, against its own checkout', async () => {
    mockFlutterwave({ 'GET /transactions/9100010/verify': verified(9100010) })
    mockRpc({ record_billing_charge: () => ({ ok: true, outcome: 'paid' }) })
    expect(
      await returnFromCheckout(checkout, { status: 'successful', transactionId: '9100010' }),
    ).toBe('paid')
    mockFlutterwave({
      'GET /transactions/9100011/verify': { status: 404, body: { status: 'error' } },
    })
    expect(
      await returnFromCheckout(checkout, { status: 'successful', transactionId: '9100011' }),
    ).toBe('pending')
    mockFlutterwave({ 'GET /transactions/9100012/verify': verified(9100012) })
    mockRpc({ record_billing_charge: () => ({ ok: true, outcome: 'renewal_failed' }) })
    expect(
      await returnFromCheckout(checkout, { status: 'successful', transactionId: '9100012' }),
    ).toBe('mismatch')
  })
})
