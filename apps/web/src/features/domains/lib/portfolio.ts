import type { DelegationStatus, LocalStatus } from '@dr/shared'

/** The portfolio row the panel works with (PRD FR-P2). */
export type PortfolioDomain = {
  id: string
  domainName: string
  tld: string
  source: 'registration' | 'transfer' | 'demo'
  testMode: boolean
  status: LocalStatus
  expiresAt: string | null
  autoRenew: boolean
  privacyEnabled: boolean
  delegationStatus: DelegationStatus
  nameservers: string[] | null
  pendingNameservers: string[] | null
}

export const EXPIRY_WINDOWS = [7, 30, 60, 90] as const
export type ExpiryWindow = (typeof EXPIRY_WINDOWS)[number]

const DAY_MS = 86_400_000

/** Whole days until expiry — negative once expired, null before registration. */
export function daysUntilExpiry(expiresAt: string | null, now: Date): number | null {
  if (!expiresAt) return null
  return Math.floor((new Date(expiresAt).getTime() - now.getTime()) / DAY_MS)
}

export type PortfolioFilter = { query?: string; expiringWithin?: ExpiryWindow | null }

/**
 * Search and the expiry view (FR-P2, FR-P5). Expiring means registered and
 * within the window — already-expired domains count, because they are the
 * ones most in need of attention.
 */
export function filterPortfolio(
  domains: PortfolioDomain[],
  { query, expiringWithin }: PortfolioFilter,
  now: Date,
): PortfolioDomain[] {
  const needle = query?.trim().toLowerCase().replace(/^\./, '') ?? ''
  return domains
    .filter((domain) => !needle || domain.domainName.toLowerCase().includes(needle))
    .filter((domain) => {
      if (!expiringWithin) return true
      const days = daysUntilExpiry(domain.expiresAt, now)
      return days !== null && days <= expiringWithin
    })
    .sort((a, b) => {
      // Soonest expiry first; domains not yet registered after the rest.
      const da = daysUntilExpiry(a.expiresAt, now) ?? Number.POSITIVE_INFINITY
      const db = daysUntilExpiry(b.expiresAt, now) ?? Number.POSITIVE_INFINITY
      return da - db || a.domainName.localeCompare(b.domainName)
    })
}

export function parseExpiryWindow(value: string | undefined): ExpiryWindow | null {
  const number = Number(value)
  return (EXPIRY_WINDOWS as readonly number[]).includes(number) ? (number as ExpiryWindow) : null
}

export const DELEGATION_LABEL: Record<DelegationStatus, string> = {
  undelegated: 'Not pointed anywhere yet',
  pending: 'Waiting to take effect',
  verified: 'Pointed and working',
  failed: 'Not working',
}
