import type { FloatState, Overview } from '@/features/admin/lib/overview-data'

/** 3 Oct 2026, 10:00 WAT (09:00 UTC). */
export const NOW = new Date('2026-10-03T09:00:00Z')

/** `NOW` minus some minutes, as SQL sends a timestamp. */
export function minutesAgo(minutes: number, from: Date = NOW): string {
  return new Date(from.getTime() - minutes * 60_000).toISOString()
}

export const hoursAgo = (hours: number) => minutesAgo(hours * 60)
export const daysAgo = (days: number) => minutesAgo(days * 24 * 60)

const window = (overrides: Partial<Overview['sales']['d7']> = {}) => ({
  netKobo: 0,
  vatKobo: 0,
  cashKobo: 0,
  ordersPaid: 0,
  lineRefundedKobo: 0,
  chargeRefundedKobo: 0,
  ...overrides,
})

/** A known runway: $43.38, nothing committed, $25.20 spent in 7 days and $90 in 30. */
export function floatState(overrides: Partial<FloatState> = {}): FloatState {
  return {
    side: 'live',
    balanceCents: 4338,
    takenAt: minutesAgo(10),
    alertCents: 2000,
    committedCents: 0,
    uncostedLines: 0,
    burn7dCents: 2520,
    burn30dCents: 9000,
    burnState: 'known',
    runwayDays: 12,
    lastKnownRunway: null,
    shortByCents: null,
    target21dCents: 7560,
    topUpToTargetCents: 3222,
    ledgerSyncedAt: minutesAgo(30),
    ledgerReadAt: minutesAgo(30),
    ...overrides,
  }
}

/** What admin_overview answers on a healthy live side, as JSON. */
export function overviewAnswer(overrides: Record<string, unknown> = {}) {
  return {
    sales: {
      d1: window(),
      d7: window({
        netKobo: 1_000_000,
        vatKobo: 75_000,
        cashKobo: 1_075_000,
        ordersPaid: 2,
        lineRefundedKobo: 0,
        chargeRefundedKobo: 0,
      }),
      d30: window({
        netKobo: 3_000_000,
        vatKobo: 225_000,
        cashKobo: 3_225_000,
        ordersPaid: 6,
        lineRefundedKobo: 500_000,
        chargeRefundedKobo: 120_000,
      }),
      d90: window({
        netKobo: 9_000_000,
        vatKobo: 675_000,
        cashKobo: 9_675_000,
        ordersPaid: 18,
        lineRefundedKobo: 1_000_000,
        chargeRefundedKobo: 120_000,
      }),
    },
    lines: {
      d7: { register: 1, renew: 0, transfer: 0, ssl: 0 },
      d30: { register: 4, renew: 1, transfer: 1, ssl: 0 },
      d90: { register: 11, renew: 3, transfer: 2, ssl: 1 },
    },
    float: floatState(),
    health: {
      heartbeats: [
        { name: 'catalogue:production', beatAt: daysAgo(2), outcome: 'written' },
        { name: 'gateway:production', beatAt: minutesAgo(2), outcome: null },
        { name: 'ssl_catalogue:production', beatAt: daysAgo(1), outcome: 'written' },
        { name: 'supplier_ledger:production', beatAt: minutesAgo(30), outcome: 'ok' },
      ],
      reconcile: { finishedAt: minutesAgo(40), error: null },
      fx: {
        activeFrom: hoursAgo(20),
        costingRate: 1328.0977,
        pendingCount: 0,
        pendingOldestAt: null,
      },
      snapshotAt: minutesAgo(10),
      cron: [
        {
          job: 'email-notices',
          schedule: '5 7 * * *',
          lastRunAt: hoursAgo(2),
          lastStatus: 'succeeded',
          lastSuccessAt: hoursAgo(2),
        },
        {
          job: 'purge-stale-carts',
          schedule: '17 3 * * *',
          lastRunAt: hoursAgo(6),
          lastStatus: 'succeeded',
          lastSuccessAt: hoursAgo(6),
        },
      ],
    },
    signups7d: 3,
    expiries30d: 2,
    revenueByDay: [
      { day: '2026-10-02', netKobo: 1_000_000 },
      { day: '2026-10-03', netKobo: 0 },
    ],
    balanceByDay: [
      { day: '2026-10-02', closeCents: null },
      { day: '2026-10-03', closeCents: 4338 },
    ],
    renewalsByMonth: [
      { month: '2026-10-01', count: 2 },
      { month: '2026-11-01', count: 0 },
    ],
    domainsByStatus: [
      { status: 'active', count: 5 },
      { status: 'pending', count: 1 },
    ],
    ...overrides,
  }
}

export function overview(overrides: Record<string, unknown> = {}): Overview {
  return overviewAnswer(overrides) as Overview
}
