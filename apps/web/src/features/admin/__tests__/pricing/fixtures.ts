import { vi } from 'vitest'
import type {
  PendingRate,
  PricingSettings,
  PricingStatus,
  RateRow,
  SampleTld,
} from '@/features/admin/lib/pricing-data'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * The Pricing & FX tests' fixtures. Every figure is deliberately not a
 * default (margin ₦4,250, an 18-cent ICANN fee, a 6.5% threshold) so a copy
 * test can tell an interpolated number from a written one.
 */

export const NOW = new Date('2026-10-03T12:00:00.000Z')

/** Hours before NOW, as an ISO time. */
export const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString()

export const ACTIVE_ID = '5b0c8a51-6f4e-4d2a-9b7c-1e2f3a4b5c6d'
export const FRESH_ID = '7c1d9b62-7a5f-4e3b-8c8d-2f3a4b5c6d7e'
export const STALE_ID = '8d2eac73-8b6a-4f4c-9d9e-3a4b5c6d7e8f'

export function settings(overrides: Partial<PricingSettings> = {}): PricingSettings {
  return {
    marginNgn: 4250,
    fxBufferPct: 1.5,
    icannFeeCents: 18,
    fxMoveThresholdPct: 6.5,
    vatPct: 7.5,
    ...overrides,
  }
}

/** .com as the catalogue holds it on 3 Oct 2026, in cents. */
export function comSample(overrides: Partial<SampleTld> = {}): SampleTld {
  return {
    name: 'com',
    registerCents: 1131,
    renewCents: 1151,
    isCountryCode: false,
    minPeriod: 1,
    maxPeriod: 10,
    registerPeriods: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    renewPeriods: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    onSale: true,
    ...overrides,
  }
}

/** .ai: a country code, sold only in two-year blocks. */
export function aiSample(): SampleTld {
  return {
    name: 'ai',
    registerCents: 9990,
    renewCents: 9990,
    isCountryCode: true,
    minPeriod: 2,
    maxPeriod: 10,
    registerPeriods: [2, 4, 6, 8, 10],
    renewPeriods: [2, 4, 6, 8, 10],
    onSale: true,
  }
}

export function rateRow(overrides: Partial<RateRow> = {}): RateRow {
  return {
    id: ACTIVE_ID,
    status: 'active',
    source: 'er-api',
    costingRate: 1330.5689,
    bufferPct: 0,
    movePct: 0.1861,
    reviewReason: null,
    quotedAt: hoursAgo(11),
    effectiveFrom: hoursAgo(3),
    createdAt: hoursAgo(3),
    reviewedAt: null,
    ...overrides,
  }
}

/** A rate held 4 hours ago, newer than the active one: Activate is offered. */
export function freshRow(overrides: Partial<RateRow> = {}): RateRow {
  return rateRow({
    id: FRESH_ID,
    status: 'pending_review',
    costingRate: 1523.4,
    bufferPct: 0,
    movePct: 14.7,
    reviewReason: 'Moved 14.7% in one update, beyond the 6.5% threshold',
    quotedAt: hoursAgo(4),
    effectiveFrom: null,
    createdAt: hoursAgo(4),
    ...overrides,
  })
}

/** The live database's stale held rate: ₦1,700 with a 4% buffer, quoted 13 days ago. */
export function staleRow(overrides: Partial<RateRow> = {}): RateRow {
  return rateRow({
    id: STALE_ID,
    status: 'pending_review',
    costingRate: 1700,
    bufferPct: 4,
    movePct: 20.5674,
    reviewReason: 'Moved 20.6% in one update, beyond the 5% threshold',
    quotedAt: hoursAgo(13 * 24),
    effectiveFrom: null,
    createdAt: hoursAgo(13 * 24),
    ...overrides,
  })
}

export function pending(row: RateRow, flags: Partial<PendingRate> = {}): PendingRate {
  return {
    id: row.id,
    costingRate: row.costingRate,
    source: row.source,
    quotedAt: row.quotedAt,
    movePct: row.movePct,
    tooOld: false,
    olderThanActive: false,
    ...flags,
  }
}

export function status(overrides: Partial<PricingStatus> = {}): PricingStatus {
  const active = rateRow()
  return {
    tlds: { total: 812, sellable: 798, paused: 3, featured: 6, transferable: 790 },
    ssl: { total: 12, sellable: 3, priced: 10 },
    fx: {
      active: {
        id: active.id,
        costingRate: active.costingRate,
        source: active.source,
        quotedAt: active.quotedAt,
        effectiveFrom: active.effectiveFrom,
      },
      pending: [pending(staleRow(), { tooOld: true, olderThanActive: true })],
    },
    settings: settings(),
    example: comSample(),
    ...overrides,
  }
}

/** `admin_pricing_status()` as its jsonb arrives: the example as SQL builds it (migration 42). */
export function statusJson(value: PricingStatus = status()): Record<string, unknown> {
  const { example, ...rest } = value
  const json = JSON.parse(JSON.stringify(rest)) as Record<string, unknown>
  json.example = example
    ? {
        name: example.name,
        registerCents: example.registerCents,
        renewCents: example.renewCents,
        isCountryCode: example.isCountryCode,
        minPeriod: example.minPeriod,
        maxPeriod: example.maxPeriod,
        registerPeriods: example.registerPeriods,
        renewPeriods: example.renewPeriods,
        isSellable: example.onSale,
        isPaused: false,
      }
    : null
  return json
}

/** A `fx_rates` row as PostgREST sends it. */
export function rawRate(row: RateRow): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    costing_rate: row.costingRate,
    buffer_pct: row.bufferPct,
    move_pct: row.movePct,
    review_reason: row.reviewReason,
    quoted_at: row.quotedAt,
    effective_from: row.effectiveFrom,
    created_at: row.createdAt,
    reviewed_at: row.reviewedAt,
  }
}

export type Call = [string, ...unknown[]]
type Answer = { data?: unknown; error?: unknown }

const METHODS = ['select', 'eq', 'in', 'order', 'limit', 'range']

/**
 * A service client whose reads record every call and answer by table, for
 * reads through adminDb (which needs `createServiceClient` mocked first).
 */
export function fakeService(answers: Record<string, Answer | Answer[]> = {}) {
  const calls: Call[] = []
  const queues = new Map(
    Object.entries(answers).map(([name, answer]) => [
      name,
      Array.isArray(answer) ? [...answer] : [answer],
    ]),
  )
  vi.mocked(createServiceClient).mockReturnValue({
    from: (name: string) => {
      calls.push(['from', name])
      const builder: Record<string, unknown> = {}
      for (const method of METHODS) {
        builder[method] = (...args: unknown[]) => {
          calls.push([method, ...args])
          return builder
        }
      }
      const queue = queues.get(name) ?? [{ data: [] }]
      const answer = (queue.length > 1 ? queue.shift() : queue[0]) ?? { data: [] }
      // biome-ignore lint/suspicious/noThenProperty: PostgREST's builder is awaited, so the fake is a thenable too
      builder.then = (resolve: (value: unknown) => unknown) =>
        resolve({ data: answer.data ?? null, error: answer.error ?? null })
      return builder
    },
  } as never)
  return calls
}
