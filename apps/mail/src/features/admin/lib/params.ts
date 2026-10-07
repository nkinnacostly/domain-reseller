import { AUDIT_ACTION } from './format'
import { ACCOUNT_STATES, type AccountState, DOMAIN_STATUSES, type DomainStatus } from './states'

/**
 * The admin lists' filters, read from the address (MAIL-SPEC §10). Only
 * shapes we know survive: a state, a page number, an action — and a search
 * only by tenant name or account id (`mdm-0123456789`), never a person's or
 * business's name, which would sit in request logs (N13).
 */

type Params = Record<string, string | string[] | undefined>

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

export function pageOf(params: Params): number {
  const n = Number(one(params.page))
  return Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : 1
}

export function accountStateOf(params: Params): AccountState | null {
  const value = one(params.state)
  return (ACCOUNT_STATES as readonly string[]).includes(value ?? '')
    ? (value as AccountState)
    : null
}

export function domainStatusFilterOf(params: Params): DomainStatus | null {
  const value = one(params.status)
  return (DOMAIN_STATUSES as readonly string[]).includes(value ?? '')
    ? (value as DomainStatus)
    : null
}

const TENANT = /^(?:mdm-)?[0-9a-f]{10}$/

/** A tenant name or short id, lower-cased; anything else is no search. */
export function tenantQueryOf(params: Params): string | null {
  const value = (one(params.q) ?? '').trim().toLowerCase()
  if (!TENANT.test(value)) return null
  return value.startsWith('mdm-') ? value : `mdm-${value}`
}

/** Which billing incidents to show: open (the default), resolved or all. */
export function incidentShowOf(params: Params): 'open' | 'resolved' | 'all' {
  const value = one(params.show)
  return value === 'resolved' || value === 'all' ? value : 'open'
}

export function auditActionOf(params: Params): string | null {
  const value = one(params.action)
  return value && Object.hasOwn(AUDIT_ACTION, value) ? value : null
}

/** An address for a list with these filters (empty ones left out). */
export function listHref(
  base: string,
  query: Record<string, string | number | null | undefined>,
): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === '' || (key === 'page' && value === 1))
      continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `${base}?${text}` : base
}
