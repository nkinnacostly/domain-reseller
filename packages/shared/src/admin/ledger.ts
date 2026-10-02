/**
 * The supplier's statement (`deposit/transactions`), as the dashboard reads
 * it (docs/ADMIN-SPEC.md §4.3, §7). The supplier publishes no meaning for its
 * integer fields; these are the shapes seen live on 2 Oct 2026. Anything else
 * is shown raw and never counted, and an entry is settled only at status 1.
 */

export type LedgerKind = 'topup' | 'domain_charge' | 'ssl_charge' | 'unclassified'

export type LedgerFacts = {
  type: number
  status: number
  chargeType: number
  productType: number
}

/** Status 1 is the only one seen settled. */
export const LEDGER_SETTLED_STATUS = 1

export function isSettled(facts: Pick<LedgerFacts, 'status'>): boolean {
  return facts.status === LEDGER_SETTLED_STATUS
}

/**
 * - `topup`: type 5, charge type 0, product type 3 (a "Ziraat Payment").
 * - `domain_charge`: charge type 1, product type 1.
 * - `ssl_charge`: charge type 1, product type 2.
 * - everything else, and anything not settled: `unclassified`.
 */
export function ledgerKind(facts: LedgerFacts): LedgerKind {
  if (!isSettled(facts)) return 'unclassified'
  if (facts.type === 5 && facts.chargeType === 0 && facts.productType === 3) return 'topup'
  if (facts.chargeType === 1 && facts.productType === 1) return 'domain_charge'
  if (facts.chargeType === 1 && facts.productType === 2) return 'ssl_charge'
  return 'unclassified'
}

/** How the mirror classified an entry (supplier_ledger_entries.match_state). */
export type LedgerMatchState = 'pending' | 'matched' | 'topup' | 'unexplained' | 'unclassified'

export const LEDGER_MATCH_LABELS: Record<LedgerMatchState, string> = {
  pending: 'Waiting to match',
  matched: 'Matched to an order',
  topup: 'Top-up',
  unexplained: 'No matching order',
  unclassified: 'Not classified',
}

/**
 * Supplier trace ids are GUIDs, not RFC 9562 UUIDs: a live top-up has version
 * nibble `b` and variant `7`, and debits come upper-case. Any 8-4-4-4-12 hex
 * string, either case, stored lower-case.
 */
export const LEDGER_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function normaliseTraceId(value: unknown): string | null {
  return typeof value === 'string' && LEDGER_GUID.test(value) ? value.toLowerCase() : null
}
