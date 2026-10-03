import {
  type AdminLedgerEntry,
  type AdminRegistrantVerification,
  type AdminRegistryListing,
  type AdminRenewCheck,
  type AdminSide,
  type AdminSupplierBalance,
  type AdminTransferState,
  type AdminTransferStateWord,
  ledgerKind,
  normaliseTraceId,
  usdToCents,
} from '@dr/shared/admin'
import { hostNames, statusWord, supplierDate } from '../provisioning/registrar'

/**
 * Every admin answer is built here, field by field, from what the supplier
 * sent (docs/ADMIN-SPEC.md §4.2). Contacts, auth codes, owner names, field
 * values, CSRs, PINs, approvers and the reseller's name never leave this
 * module: nothing is copied whole, so nothing unlisted can reach a cache, a
 * log line or a `supplier_calls` message. Dollars become cents here.
 */

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const text = (value: unknown, max = 200): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null

const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)

const int = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) ? value : null

/** `deposit/accounts/me`: the balance in cents and the price group's name. */
export function toBalance(
  body: unknown,
  side: AdminSide,
  readAt: string,
): AdminSupplierBalance | null {
  const raw = record(body)
  if (typeof raw.usdBalance !== 'number' && typeof raw.usdBalance !== 'string') return null
  return {
    side,
    balanceCents: usdToCents(raw.usdBalance as number | string),
    priceGroup: text(raw.resellerGroupName, 60),
    readAt,
  }
}

/**
 * One `deposit/transactions` item. Spend is `balance − oldBalance` in cents:
 * `amount` is always 0 (§7). Times are the supplier's UTC+3. Null for an item
 * without a GUID trace id or its two balances.
 */
export function toLedgerEntry(item: unknown): AdminLedgerEntry | null {
  const raw = record(item)
  const traceId = normaliseTraceId(raw.traceId)
  const occurredAt = supplierDate(raw.creationTime)
  const facts = {
    type: int(raw.type),
    status: int(raw.status),
    chargeType: int(raw.chargeType),
    productType: int(raw.productType),
  }
  if (
    !traceId ||
    !occurredAt ||
    facts.type === null ||
    facts.status === null ||
    facts.chargeType === null ||
    facts.productType === null ||
    (typeof raw.balance !== 'number' && typeof raw.balance !== 'string') ||
    (typeof raw.oldBalance !== 'number' && typeof raw.oldBalance !== 'string')
  ) {
    return null
  }
  const before = usdToCents(raw.oldBalance as number | string)
  const after = usdToCents(raw.balance as number | string)
  const typed = facts as { type: number; status: number; chargeType: number; productType: number }
  return {
    traceId,
    occurredAt,
    ...typed,
    description: text(raw.description, 300) ?? '',
    period: int(raw.period),
    deltaCents: after - before,
    balanceBeforeCents: before,
    balanceAfterCents: after,
    kind: ledgerKind(typed),
  }
}

/** One `domains` listing item: no contacts. */
export function toRegistryListing(item: unknown): AdminRegistryListing | null {
  const raw = record(item)
  const name = text(raw.domainName, 253)
  if (!name) return null
  return {
    name: name.toLowerCase(),
    status: raw.status === undefined ? null : statusWord(raw.status),
    expiresAt: supplierDate(raw.expirationDate),
    rgpExpiresAt: supplierDate(raw.rgpExpirationDate),
    transferLock: bool(raw.lockStatus),
    privacy: bool(raw.privacyProtectionStatus),
    renewalModeLabel: text(raw.renewalMode, 40),
    nameservers: hostNames(raw.nameservers),
  }
}

/**
 * The registrant's ICANN email verification: whether and when, never the
 * address verified or the owner's name.
 */
export function toVerification(
  body: unknown,
  name: string,
  readAt: string,
): AdminRegistrantVerification | null {
  const results = record(body).results
  if (!Array.isArray(results) || results.length === 0) return null
  const latest = record(results[0])
  return {
    name,
    isVerified: latest.isUserVerified === true,
    operationStatus: text(latest.operationStatus, 40),
    verifiedAt: supplierDate(latest.userVerificationDate),
    fieldType: text(latest.fieldType, 20),
    readAt,
  }
}

/**
 * EPP transfer statuses as `domains/transfers/query` reports them. No
 * transfer was in flight in the sandbox on 2 Oct 2026, so the words come from
 * RFC 5731; anything else is `unknown`, never guessed either way (I2).
 */
const TRANSFER_WORDS: Record<string, AdminTransferStateWord> = {
  pending: 'pending',
  pendingtransfer: 'pending',
  clientapproved: 'completed',
  serverapproved: 'completed',
  approved: 'completed',
  completed: 'completed',
  clientrejected: 'rejected',
  serverrejected: 'rejected',
  rejected: 'rejected',
  clientcancelled: 'cancelled',
  servercancelled: 'cancelled',
  cancelled: 'cancelled',
}

export function transferWord(status: unknown): AdminTransferStateWord {
  const key = String(status ?? '')
    .replace(/[\s_-]/g, '')
    .toLowerCase()
  return TRANSFER_WORDS[key] ?? 'unknown'
}

export function toTransferState(body: unknown, name: string, readAt: string): AdminTransferState {
  const raw = record(body)
  return {
    name,
    state: transferWord(raw.status),
    supplierStatus: text(raw.status, 40),
    requestedAt: supplierDate(raw.requestedDate),
    finalAt: supplierDate(raw.finalDate),
    readAt,
  }
}

/** Our keys for the supplier's renew-check refusals (N10): the period and the lock are the two seen. */
const RENEW_REASONS: Record<string, string> = {
  'Dna.DomainService:Domain:1016': 'PERIOD_NOT_ALLOWED',
}

export function toRenewCheck(body: unknown, name: string, readAt: string): AdminRenewCheck {
  const raw = record(body)
  const key = text(raw.errorMessageKey, 80)
  return {
    name,
    renewable: raw.renewabilityStatus === true,
    renewalLock: raw.renewalLock === true,
    reasonKey: key ? (RENEW_REASONS[key] ?? 'NOT_RENEWABLE') : null,
    readAt,
  }
}

/** `products/info`'s selling price for the period, in cents; null when unreadable. */
export function sellingCents(body: unknown): number | null {
  const raw = record(body)
  if (
    raw.sellingCurrency !== undefined &&
    raw.sellingCurrency !== null &&
    raw.sellingCurrency !== 'USD'
  ) {
    return null
  }
  if (typeof raw.sellingPrice !== 'number' && typeof raw.sellingPrice !== 'string') return null
  try {
    return usdToCents(raw.sellingPrice as number | string)
  } catch {
    return null
  }
}

/** The supplier's error code from an error body (`Dna.DomainService:Domain:10007`). */
export function errorCode(body: unknown): string | null {
  return text(record(record(body).error).code, 80)
}
