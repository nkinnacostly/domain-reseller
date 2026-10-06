import { revalidatePath } from 'next/cache'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { mockRpc } from '../../../../tests/mocks/supabase'
import { fakeSupabase } from '../../accounts/__tests__/fake-supabase'
import { ACCOUNT_ID, freeOverview, starterOverview, subscription } from './fixtures'
import { KEY_VAR, mockFlutterwave, setBillingEnv } from './flutterwave-mock'

/**
 * Changing plan (MAIL-SPEC §8): the role check first, SQL's quote and
 * refusals, and Flutterwave stopped before anything is scheduled — so the
 * card is never charged for a month the account will not have.
 */

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => ({}) }))

const { keepPlan, scheduleChange, startCheckout } = await import('../actions/billing')

const CHECKOUT = '7f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f'

function session(options: Parameters<typeof fakeSupabase>[0] = {}) {
  const fake = fakeSupabase({
    user: { id: 'user-1', email: 'ada@example.com' },
    tables: { accounts: { single: { data: { name: 'Acme' }, error: null } } },
    ...options,
  })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}

const provider = (sub: Record<string, unknown> | null) => () => ({ ok: true, subscription: sub })

beforeEach(() => {
  vi.clearAllMocks()
  setBillingEnv()
})
afterEach(() =>
  setBillingEnv({
    [KEY_VAR]: undefined,
    FLUTTERWAVE_WEBHOOK_HASH: undefined,
    FLUTTERWAVE_API_URL: undefined,
  }),
)

describe('startCheckout', () => {
  const input = { accountId: ACCOUNT_ID, planCode: 'starter', expectedTotalKobo: 2_150_000 }

  it('says paid plans are not on sale until Flutterwave is set up', async () => {
    setBillingEnv({ [KEY_VAR]: undefined })
    const fake = session()
    const result = await startCheckout(input)
    expect(result.data).toEqual({ error: expect.stringContaining('not on sale yet') })
    expect(fake.rpcCalls).toEqual([])
  })

  it('is for owners and admins only', async () => {
    const fake = session({ role: 'developer' })
    const result = await startCheckout(input)
    expect(result.serverError).toContain('Your role in this account cannot do that')
    expect(fake.rpcCalls).toEqual([])
  })

  it('starts the checkout in SQL, then sends the person to Flutterwave', async () => {
    const fake = session({
      rpc: {
        start_checkout: () => ({
          data: {
            ok: true,
            checkoutId: CHECKOUT,
            txRef: `MDM-${CHECKOUT}`,
            planName: 'Starter',
            totalKobo: 2_150_000,
          },
          error: null,
        }),
      },
    })
    const service = mockRpc({
      billing_provider_state: provider(null),
      flutterwave_plan_for: () => ({
        ok: true,
        planName: 'Starter',
        amountKobo: 2_150_000,
        flutterwavePlanId: 3807,
      }),
    })
    const flw = mockFlutterwave({
      'POST /payments': {
        body: { status: 'success', data: { link: 'https://checkout.test/pay/9' } },
      },
    })
    const result = await startCheckout(input)
    expect(result.data).toEqual({ redirectTo: 'https://checkout.test/pay/9' })
    expect(service.map((c) => c.fn)).toEqual(['billing_provider_state', 'flutterwave_plan_for'])
    expect(fake.rpcCalls[0]).toEqual({
      fn: 'start_checkout',
      args: {
        p_account_id: ACCOUNT_ID,
        p_plan_code: 'starter',
        p_test_mode: true,
        p_flutterwave_plan_id: 3807,
        p_expected_total_kobo: 2_150_000,
      },
    })
    expect(flw[0]?.body).toMatchObject({
      tx_ref: `MDM-${CHECKOUT}`,
      amount: 21500,
      payment_plan: 3807,
      redirect_url: `http://localhost:3001/dashboard/billing/complete?checkout=${CHECKOUT}`,
      customer: { email: 'ada@example.com', name: 'Acme' },
    })
  })

  it('words SQL’s refusal, and starts no payment', async () => {
    session({
      rpc: { start_checkout: () => ({ data: { ok: false, code: 'quote_changed' }, error: null }) },
    })
    mockRpc({
      billing_provider_state: provider(null),
      flutterwave_plan_for: () => ({
        ok: true,
        planName: 'Starter',
        amountKobo: 1,
        flutterwavePlanId: 1,
      }),
    })
    const flw = mockFlutterwave({})
    const result = await startCheckout(input)
    expect(result.data).toEqual({ error: expect.stringContaining('The price changed') })
    expect(flw).toEqual([])
  })

  it('stops a past-due plan’s Flutterwave subscription before a new payment', async () => {
    const fake = session()
    mockRpc({
      billing_provider_state: provider({
        status: 'past_due',
        firstTransactionId: '91',
        providerCanceled: false,
      }),
    })
    mockFlutterwave({ 'GET /subscriptions': { status: 503, body: { status: 'error' } } })
    const result = await startCheckout(input)
    expect(result.data).toEqual({
      error: expect.stringContaining('could not confirm the change with Flutterwave'),
    })
    expect(fake.rpcCalls).toEqual([])
  })

  it('says so when Flutterwave gives no plan object or no payment page', async () => {
    session({
      rpc: {
        start_checkout: () => ({
          data: { ok: true, checkoutId: CHECKOUT, txRef: `MDM-${CHECKOUT}`, totalKobo: 2_150_000 },
          error: null,
        }),
      },
    })
    mockRpc({ billing_provider_state: provider(null), flutterwave_plan_for: () => ({ ok: false }) })
    expect((await startCheckout(input)).data).toEqual({
      error: expect.stringContaining('could not set up the payment'),
    })
    mockRpc({
      billing_provider_state: provider(null),
      flutterwave_plan_for: () => ({
        ok: true,
        planName: 'Starter',
        amountKobo: 1,
        flutterwavePlanId: 1,
      }),
    })
    mockFlutterwave({ 'POST /payments': { status: 500, body: { status: 'error' } } })
    expect((await startCheckout(input)).data).toEqual({
      error: expect.stringContaining('You have not been charged'),
    })
  })
})

describe('scheduleChange', () => {
  const cancel = { accountId: ACCOUNT_ID, planCode: 'free' }

  it('stops Flutterwave first, then schedules the change', async () => {
    const fake = session({
      rpc: {
        billing_overview: () => ({ data: starterOverview(), error: null }),
        schedule_plan_change: () => ({ data: { ok: true }, error: null }),
      },
    })
    const service = mockRpc({
      billing_provider_state: provider({
        status: 'active',
        firstTransactionId: '91',
        providerCanceled: false,
      }),
      note_provider_canceled: () => ({ ok: true }),
    })
    const flw = mockFlutterwave({
      'GET /subscriptions': { body: { status: 'success', data: [{ id: 5, status: 'active' }] } },
      'PUT /subscriptions/5/cancel': { body: { status: 'success', data: { status: 'cancelled' } } },
    })
    expect((await scheduleChange(cancel)).data).toEqual({ ok: true })
    expect(flw.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /subscriptions?transaction_id=91',
      'PUT /subscriptions/5/cancel',
    ])
    expect(service.map((c) => c.fn)).toEqual(['billing_provider_state', 'note_provider_canceled'])
    expect(fake.rpcCalls.map((c) => c.fn)).toEqual(['billing_overview', 'schedule_plan_change'])
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/billing')
  })

  it('never stops the card for a change SQL would refuse', async () => {
    session({ rpc: { billing_overview: () => ({ data: starterOverview(), error: null }) } })
    const flw = mockFlutterwave({})
    expect((await scheduleChange({ accountId: ACCOUNT_ID, planCode: 'pro' })).data).toEqual({
      error: expect.stringContaining('A move to a bigger plan happens at once'),
    })
    expect((await scheduleChange({ accountId: ACCOUNT_ID, planCode: 'starter' })).data).toEqual({
      error: 'You are already on that plan.',
    })
    expect((await scheduleChange({ accountId: ACCOUNT_ID, planCode: 'scale' })).data).toEqual({
      error: expect.stringContaining('not on offer'),
    })
    session({
      rpc: {
        billing_overview: () => ({
          data: starterOverview({
            subscription: subscription({
              status: 'past_due',
              pastDueReason: 'renewal_failed',
              pastDueUntil: '2026-11-13T10:00:00Z',
            }),
          }),
          error: null,
        }),
      },
    })
    expect((await scheduleChange(cancel)).data).toEqual({
      error: expect.stringContaining('has not come through'),
    })
    session({ rpc: { billing_overview: () => ({ data: null, error: { code: '08006' } }) } })
    expect((await scheduleChange(cancel)).data).toEqual({
      error: expect.stringContaining('Nothing was changed'),
    })
    expect(flw).toEqual([])
  })

  it('changes nothing when Flutterwave cannot confirm the stop', async () => {
    const fake = session({
      rpc: { billing_overview: () => ({ data: starterOverview(), error: null }) },
    })
    mockRpc({
      billing_provider_state: provider({
        status: 'active',
        firstTransactionId: '91',
        providerCanceled: false,
      }),
    })
    mockFlutterwave({ 'GET /subscriptions': { body: { status: 'success', data: [] } } })
    expect((await scheduleChange(cancel)).data).toEqual({
      error: expect.stringContaining('Nothing was changed'),
    })
    expect(fake.rpcCalls.map((c) => c.fn)).toEqual(['billing_overview'])
  })

  it('starts the card again if SQL refuses after the stop', async () => {
    session({
      rpc: {
        billing_overview: () => ({ data: starterOverview(), error: null }),
        schedule_plan_change: () => ({ data: { ok: false, code: 'provider_active' }, error: null }),
      },
    })
    const service = mockRpc({
      billing_provider_state: provider({
        status: 'active',
        firstTransactionId: '91',
        providerCanceled: false,
      }),
      note_provider_canceled: () => ({ ok: true }),
      note_provider_active: () => ({ ok: true }),
    })
    const flw = mockFlutterwave({
      'GET /subscriptions': { body: { status: 'success', data: [{ id: 5, status: 'active' }] } },
      'PUT /subscriptions/5/cancel': { body: { status: 'success', data: { status: 'cancelled' } } },
      'PUT /subscriptions/5/activate': { body: { status: 'success', data: { status: 'active' } } },
    })
    expect((await scheduleChange(cancel)).data).toEqual({
      error: expect.stringContaining('Flutterwave'),
    })
    expect(flw.map((c) => c.method)).toContain('PUT')
    expect(service.map((c) => c.fn)).toContain('note_provider_active')
  })

  it('needs a subscription to change', async () => {
    session({ rpc: { billing_overview: () => ({ data: starterOverview(), error: null }) } })
    mockRpc({ billing_provider_state: provider(null) })
    expect((await scheduleChange(cancel)).data).toEqual({
      error: 'This account has no paid plan to change.',
    })
    setBillingEnv({ FLUTTERWAVE_WEBHOOK_HASH: undefined })
    expect((await scheduleChange(cancel)).data).toEqual({
      error: expect.stringContaining('not on sale'),
    })
  })
})

describe('keepPlan', () => {
  it('starts Flutterwave’s subscription again, then withdraws the change', async () => {
    const fake = session({
      rpc: { keep_current_plan: () => ({ data: { ok: true }, error: null }) },
    })
    mockRpc({
      billing_provider_state: provider({
        status: 'active',
        firstTransactionId: '91',
        providerCanceled: true,
        scheduledPlanCode: 'free',
      }),
      note_provider_active: () => ({ ok: true }),
    })
    mockFlutterwave({
      'GET /subscriptions': { body: { status: 'success', data: [{ id: 5, status: 'cancelled' }] } },
      'PUT /subscriptions/5/activate': { body: { status: 'success', data: { status: 'active' } } },
    })
    expect((await keepPlan({ accountId: ACCOUNT_ID })).data).toEqual({ ok: true })
    expect(fake.rpcCalls.map((c) => c.fn)).toEqual(['keep_current_plan'])
  })

  it('refuses when nothing is scheduled, or Flutterwave will not restart', async () => {
    const fake = session()
    mockRpc({
      billing_provider_state: provider({
        status: 'active',
        firstTransactionId: '91',
        providerCanceled: false,
      }),
    })
    expect((await keepPlan({ accountId: ACCOUNT_ID })).data).toEqual({
      error: 'No change is scheduled.',
    })
    mockRpc({
      billing_provider_state: provider({
        status: 'active',
        firstTransactionId: '91',
        providerCanceled: true,
        scheduledPlanCode: 'free',
      }),
    })
    mockFlutterwave({ 'GET /subscriptions': { status: 500, body: {} } })
    expect((await keepPlan({ accountId: ACCOUNT_ID })).data).toEqual({
      error: expect.stringContaining('Nothing was changed'),
    })
    expect(fake.rpcCalls).toEqual([])
    expect(freeOverview().subscription).toBeNull()
  })
})
