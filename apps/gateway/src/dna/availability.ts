import type { AvailabilityStatus } from '@dr/shared'
import type { DnaAvailability } from 'nodejs-dna'

/**
 * Turns one supplier availability row into our status.
 *
 * Observed against production on 22 Sept 2026:
 * - a registered name: `notavailable`, Reason "Domain exists" / "In use"
 * - a registry premium: `notavailable`, `IsFee: true`, Reason "Premium domain
 *   name. Please cont[act]" — it cannot be registered through the API, so we
 *   flag it rather than price it (answers PRD V7)
 * - a name the extension forbids: `notavailable`, Reason "The domain name must
 *   contain at least 3 and no more than 63 characters."
 *
 * The Reason text is the supplier's, not a contract, so anything we do not
 * recognise falls to `restricted` — never to `available`.
 */
export function classifyAvailability(
  row: Pick<DnaAvailability, 'Status' | 'IsFee' | 'Reason'>,
): AvailabilityStatus {
  if (row.IsFee) return 'premium'
  if (row.Status.toLowerCase() === 'available') return 'available'
  if (/exist|in use|registered|taken/i.test(row.Reason ?? '')) return 'registered'
  return 'restricted'
}
