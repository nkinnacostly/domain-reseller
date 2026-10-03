import type { AdminCataloguePreview } from '@dr/shared/admin'
import type { SupplierFloat, Topup } from '@/features/admin/lib/supplier-data'

/** 3 Oct 2026, 15:00 WAT (14:00 UTC). */
export const NOW = new Date('2026-10-03T14:00:00Z')

export function minutesAgo(minutes: number, from: Date = NOW): string {
  return new Date(from.getTime() - minutes * 60_000).toISOString()
}

export const daysAgo = (days: number) => minutesAgo(days * 24 * 60)

/** A live trace id shaped as the supplier sends it: not an RFC 9562 uuid (version nibble b). */
export const TRACE = '0f1e2d3c-4b5a-b697-7887-a1b2c3d4e5f6'

export function topup(overrides: Partial<Topup> = {}): Topup {
  return {
    id: null,
    traceId: TRACE,
    occurredAt: daysAgo(4),
    usdCents: 3600,
    ngnPaidKobo: null,
    rateKoboPerCent: null,
    reference: null,
    supersedesId: null,
    recordedBy: null,
    ...overrides,
  }
}

/**
 * `admin_float` on a healthy live side: $43.38 taken at 14:00 WAT, $25.20
 * spent in 7 days, about 12 days of runway, two top-ups — one recorded.
 */
export function supplierFloat(overrides: Partial<SupplierFloat> = {}): SupplierFloat {
  return {
    side: 'live',
    balanceCents: 4338,
    takenAt: minutesAgo(60),
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
    topups: [
      topup(),
      topup({
        id: 7,
        traceId: '11111111-2222-3333-4444-555555555555',
        occurredAt: daysAgo(10),
        usdCents: 1500,
        ngnPaidKobo: 2_430_000,
        rateKoboPerCent: 1620,
        reference: 'GTB-0042',
        supersedesId: 6,
        recordedBy: 'owner',
      }),
    ],
    ...overrides,
  }
}

/** `admin_float` as SQL sends it, JSON. */
export function floatAnswer(overrides: Record<string, unknown> = {}) {
  return { ...supplierFloat(), ...overrides }
}

/** A preview as the gateway answers it: the sync's own report, as `formatReport` writes it. */
export function preview(overrides: Partial<AdminCataloguePreview> = {}): AdminCataloguePreview {
  return {
    kind: 'tlds',
    outcome: 'ok',
    reason: null,
    listed: 724,
    sellable: 705,
    changes: 3,
    report: [
      'Fetched 724 extensions from the reseller platform; 705 sellable',
      '',
      '+1 added · -0 retired · ~2 price changes · ~0 other changes · 721 unchanged',
      '',
      'Added:   .africa',
      '',
      'Wholesale changes:',
      '  .com             register $11.31 → $11.48   renew $11.31 → $11.48',
      '  .net             register $13.10 → $13.40   renew $13.10 → $13.40',
      '',
      'Report only. Re-run with --apply to write.',
    ],
    readAt: minutesAgo(1),
    ...overrides,
  }
}
