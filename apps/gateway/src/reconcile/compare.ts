import { nameserverSchema } from '@dr/shared'
import { type RegistryListing, transferState } from '../provisioning/registrar'
import { sameNameservers } from '../provisioning/saga'

/**
 * Only real hostnames are copied from the registry. A parsing slip once
 * stored "[object object]" as every domain's nameservers (26 Sept 2026); a
 * set with anything that is not a hostname is left alone, never recorded.
 */
const allHostnames = (hosts: readonly string[]) =>
  hosts.every((host) => nameserverSchema.safeParse(host).success)

/**
 * Our domains against the registry's listing (PRD §13.5). Pure: the
 * reconciler fetches, this decides, the database records.
 *
 * The registry is the truth for expiry, nameservers, lock and privacy, so
 * those are copied over. What needs a person becomes a finding:
 * - `supplier_renewed` — expiry moved later and we renewed nothing. We have
 *   no renewals yet, so every such move is the supplier's auto-renew,
 *   paid from our balance (backlog L18).
 * - `supplier_may_renew` — the customer turned auto-renew off, the
 *   supplier's is on, and expiry is near: act before the supplier does.
 * - `missing_at_registry`, `unknown_domain`, `registered_but_failed`,
 *   `status_mismatch`, `expiry_moved_earlier` — records that disagree.
 * A transfer in still under way is left to its job; one we failed that the
 * registry has anyway is `registered_but_failed`, like a failed registration.
 */

export type OurDomain = {
  id: string
  domainName: string
  localStatus: string
  expiresAt: string | null
  nameservers: string[] | null
  pendingNameservers: string[] | null
  autoRenew: boolean
  transferLock: boolean
  privacy: boolean
}

export type FindingKind =
  | 'supplier_renewed'
  | 'expiry_moved_earlier'
  | 'status_mismatch'
  | 'missing_at_registry'
  | 'unknown_domain'
  | 'registered_but_failed'
  | 'supplier_may_renew'

export type Finding = {
  domainId: string | null
  domainName: string
  kind: FindingKind
  detail: Record<string, unknown>
}

export type DomainEvent = { type: string; payload: Record<string, unknown> }

export type DomainUpdate = {
  domainId: string
  registryStatus: string
  renewalMode: string | null
  expiresAt?: string
  nameservers?: string[]
  transferLock?: boolean
  privacy?: boolean
  events: DomainEvent[]
}

export type Comparison = { updates: DomainUpdate[]; findings: Finding[] }

/** Statuses in which we hold the name at the registry. */
const HELD = new Set([
  'active',
  'expired_grace',
  'redemption',
  'pending_delete',
  'pending_verification',
])
/** A transfer in that its job still owns (PRD E9): the job reads the registry itself. */
const TRANSFER_OPEN = new Set(['transfer_requested', 'transfer_pending'])
/** A transfer in we failed — and refunded. */
const TRANSFER_FAILED = new Set(['transfer_rejected', 'transfer_cancelled'])
const DAY_MS = 86_400_000
/** Expiry differences below this are clock and zone noise, not a renewal. */
const EXPIRY_TOLERANCE_MS = DAY_MS

export function isSupplierAutoRenew(mode: string | null): boolean {
  return mode !== null && /auto/i.test(mode)
}

export function compareWithRegistry(
  ours: OurDomain[],
  listing: RegistryListing[],
  { now, warnDays = 45 }: { now: Date; warnDays?: number },
): Comparison {
  const registry = new Map(listing.map((item) => [item.domainName.toLowerCase(), item]))
  const rowsByName = new Map<string, OurDomain[]>()
  for (const row of ours) {
    const name = row.domainName.toLowerCase()
    rowsByName.set(name, [...(rowsByName.get(name) ?? []), row])
  }

  const updates: DomainUpdate[] = []
  const findings: Finding[] = []

  for (const [name, rows] of rowsByName) {
    const listed = registry.get(name)
    const held = rows.find((row) => HELD.has(row.localStatus))

    if (!held) {
      // A transfer still moving is its job's to settle — listed as waiting,
      // or not listed yet, it is not drift.
      if (rows.some((row) => TRANSFER_OPEN.has(row.localStatus))) continue
      // A line we failed that the registry has anyway: we paid for it, and
      // the customer may be owed the domain rather than a refund. A failed
      // transfer the registry shows cancelled or gone is simply over.
      const failed = rows.find(
        (row) =>
          row.localStatus === 'registration_failed' ||
          (TRANSFER_FAILED.has(row.localStatus) &&
            listed !== undefined &&
            transferState(listed.status) !== 'gone'),
      )
      if (failed && listed) {
        findings.push({
          domainId: failed.id,
          domainName: name,
          kind: 'registered_but_failed',
          detail: { registry_status: listed.status, expires_at: listed.expiresAt },
        })
      }
      // Pending rows belong to their registration job.
      continue
    }

    if (!listed) {
      findings.push({
        domainId: held.id,
        domainName: name,
        kind: 'missing_at_registry',
        detail: { local_status: held.localStatus },
      })
      continue
    }

    const update: DomainUpdate = {
      domainId: held.id,
      registryStatus: listed.status,
      renewalMode: listed.renewalMode,
      events: [],
    }

    if (held.localStatus === 'active' && !/^(active|ok)$/i.test(listed.status)) {
      findings.push({
        domainId: held.id,
        domainName: name,
        kind: 'status_mismatch',
        detail: { local_status: held.localStatus, registry_status: listed.status },
      })
    }

    if (listed.expiresAt) {
      const moved = held.expiresAt ? Date.parse(listed.expiresAt) - Date.parse(held.expiresAt) : 0
      if (!held.expiresAt || Math.abs(moved) > EXPIRY_TOLERANCE_MS) {
        update.expiresAt = listed.expiresAt
      }
      if (held.expiresAt && Math.abs(moved) > EXPIRY_TOLERANCE_MS) {
        findings.push({
          domainId: held.id,
          domainName: name,
          kind: moved > 0 ? 'supplier_renewed' : 'expiry_moved_earlier',
          detail: { ours: held.expiresAt, registry: listed.expiresAt },
        })
        update.events.push({
          type: 'expiry_updated_from_registry',
          payload: { before: held.expiresAt, after: listed.expiresAt },
        })
      }
    }

    // A change of ours still waiting to be applied is left to its job.
    if (
      !held.pendingNameservers &&
      listed.nameservers.length > 0 &&
      allHostnames(listed.nameservers) &&
      !sameNameservers(listed.nameservers, held.nameservers ?? [])
    ) {
      update.nameservers = listed.nameservers
      update.events.push({
        type: 'nameservers_synced',
        payload: { before: held.nameservers ?? [], after: listed.nameservers },
      })
    }

    if (listed.transferLock !== held.transferLock) update.transferLock = listed.transferLock
    if (listed.privacy !== held.privacy) update.privacy = listed.privacy

    const expiresAt = update.expiresAt ?? held.expiresAt
    if (
      !held.autoRenew &&
      isSupplierAutoRenew(listed.renewalMode) &&
      expiresAt &&
      Date.parse(expiresAt) - now.getTime() <= warnDays * DAY_MS
    ) {
      findings.push({
        domainId: held.id,
        domainName: name,
        kind: 'supplier_may_renew',
        detail: { expires_at: expiresAt, renewal_mode: listed.renewalMode },
      })
    }

    updates.push(update)
  }

  for (const [name, listed] of registry) {
    if (rowsByName.has(name)) continue
    findings.push({
      domainId: null,
      domainName: name,
      kind: 'unknown_domain',
      detail: {
        registry_status: listed.status,
        expires_at: listed.expiresAt,
        renewal_mode: listed.renewalMode,
      },
    })
  }

  return { updates, findings }
}
