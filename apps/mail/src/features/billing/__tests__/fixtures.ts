/**
 * `billing_overview` answers as migration 50 builds them, for tests. Amounts
 * are the seeded plans' (Starter ₦20,000, Pro ₦55,000, before 7.5% VAT).
 */

export const ACCOUNT_ID = '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e'

type Change = 'current' | 'subscribe' | 'upgrade' | 'downgrade' | 'cancel' | 'pay' | 'none'

export function quote(code: string, change: Change, extra: Record<string, unknown> = {}) {
  const price = code === 'free' ? 0 : code === 'starter' ? 2_000_000 : 5_500_000
  const credit = Number(extra.creditKobo ?? 0)
  const subtotal = price - credit
  const vat = Math.floor((subtotal * 750 + 5000) / 10000)
  return {
    planCode: code,
    change,
    priceKobo: price,
    creditKobo: credit,
    subtotalKobo: subtotal,
    vatBps: 750,
    vatKobo: vat,
    totalKobo: subtotal + vat,
    recurringKobo: price + Math.floor((price * 750 + 5000) / 10000),
    fromPlanCode: null,
    creditUntil: null,
    ...extra,
  }
}

export function planRow(code: string, change: Change, extra: Record<string, unknown> = {}) {
  const caps = {
    free: [3000, 100, 1, 1, 7],
    starter: [50_000, 5000, 5, 3, 30],
    pro: [150_000, 20_000, 20, 10, 30],
  }[code] ?? [1, 1, 1, 1, 1]
  return {
    code,
    name: code[0]?.toUpperCase() + code.slice(1),
    priceKobo: code === 'free' ? 0 : code === 'starter' ? 2_000_000 : 5_500_000,
    monthlyCap: caps[0],
    dailyCap: caps[1],
    maxDomains: caps[2],
    maxMembers: caps[3],
    logRetentionDays: caps[4],
    isOffered: true,
    quote: quote(code, change, extra),
  }
}

export function subscription(extra: Record<string, unknown> = {}) {
  return {
    status: 'active',
    planCode: 'starter',
    planName: 'Starter',
    testMode: true,
    priceKobo: 2_000_000,
    vatBps: 750,
    amountKobo: 2_150_000,
    currentPeriodStart: '2026-10-06T10:00:00Z',
    currentPeriodEnd: '2026-11-06T10:00:00Z',
    scheduledPlanCode: null,
    scheduledPlanName: null,
    pastDueReason: null,
    pastDueSince: null,
    pastDueUntil: null,
    endedAt: null,
    endedReason: null,
    card: { last4: '4242', brand: 'VISA' },
    ...extra,
  }
}

/** A Free account with no subscription, as its owner sees it. */
export function freeOverview(extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    role: 'owner',
    canManage: true,
    vatBps: 750,
    pastDueDays: 7,
    plan: { code: 'free', name: 'Free', priceKobo: 0 },
    subscription: null,
    plans: [
      planRow('free', 'current'),
      planRow('starter', 'subscribe'),
      planRow('pro', 'subscribe'),
    ],
    ...extra,
  }
}

/** Starter, paid and active. */
export function starterOverview(extra: Record<string, unknown> = {}) {
  return {
    ...freeOverview(),
    plan: { code: 'starter', name: 'Starter', priceKobo: 2_000_000 },
    subscription: subscription(),
    plans: [
      planRow('free', 'cancel'),
      planRow('starter', 'current'),
      planRow('pro', 'upgrade', { creditKobo: 1_333_333, fromPlanCode: 'starter' }),
    ],
    ...extra,
  }
}

export const INVOICE_ROW = {
  id: '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  number: 'MDM-TEST-INV-000042',
  account_id: ACCOUNT_ID,
  payment_id: '6e2d3c4b-5f60-4b7c-9d8e-0f1a2b3c4d5e',
  test_mode: true,
  issued_at: '2026-10-06T10:00:00Z',
  billed_to: { name: 'Acme Ltd', website: 'https://acme.example' },
  plan_code: 'pro',
  plan_name: 'Pro',
  period_start: '2026-10-06T10:00:00Z',
  period_end: '2026-11-06T10:00:00Z',
  lines: [
    { description: 'Pro plan, one month', amountKobo: 5_500_000 },
    {
      description: 'Credit for the unused part of the Starter plan’s month',
      amountKobo: -1_333_333,
    },
  ],
  subtotal_kobo: 4_166_667,
  vat_bps: 750,
  vat_kobo: 312_500,
  total_kobo: 4_479_167,
  paid_kobo: 4_479_167,
  provider_reference: '9100001',
  tx_ref: 'MDM-11111111-2222-4333-8444-555555555555',
  method: 'card',
}
