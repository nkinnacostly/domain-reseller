import type { DelegationStatus, LocalStatus } from '@dr/shared'
import type { DomainLabel } from './labels'

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
  transferLock: boolean
  delegationStatus: DelegationStatus
  nameservers: string[] | null
  pendingNameservers: string[] | null
  /**
   * The registrar has put the name on hold, so it does not resolve
   * (`isRegistryHold` on the reconcile's `registry_status`). Only ever set on
   * a domain we still hold; absent means not on hold.
   */
  onHold?: boolean
  /** FR-P3 — the account's own labels on this domain, by name. */
  labels: DomainLabel[]
}

export const EXPIRY_WINDOWS = [7, 30, 60, 90] as const
export type ExpiryWindow = (typeof EXPIRY_WINDOWS)[number]

const DAY_MS = 86_400_000

/** Whole days until expiry — negative once expired, null before registration. */
export function daysUntilExpiry(expiresAt: string | null, now: Date): number | null {
  if (!expiresAt) return null
  return Math.floor((new Date(expiresAt).getTime() - now.getTime()) / DAY_MS)
}

export type PortfolioFilter = {
  query?: string
  expiringWithin?: ExpiryWindow | null
  labelId?: string | null
}

/**
 * Search, the expiry view and the label filter (FR-P2, FR-P5, FR-P3).
 * Expiring means registered and within the window — already-expired domains
 * count, because they are the ones most in need of attention.
 */
export function filterPortfolio(
  domains: PortfolioDomain[],
  { query, expiringWithin, labelId }: PortfolioFilter,
  now: Date,
): PortfolioDomain[] {
  const needle = query?.trim().toLowerCase().replace(/^\./, '') ?? ''
  return domains
    .filter((domain) => !needle || domain.domainName.toLowerCase().includes(needle))
    .filter((domain) => !labelId || domain.labels.some((label) => label.id === labelId))
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

/**
 * The portfolio's address with its filters, each kept when another changes.
 * A page is kept only when asked for: changing a filter starts again at page 1.
 */
export function portfolioHref({
  query,
  within,
  labelId,
  page,
}: {
  query?: string
  within?: ExpiryWindow | null
  labelId?: string | null
  page?: number
}): string {
  const params = new URLSearchParams()
  if (query) params.set('q', query)
  if (within) params.set('within', String(within))
  if (labelId) params.set('label', labelId)
  if (page && page > 1) params.set('page', String(page))
  const search = params.toString()
  return search ? `/app/domains?${search}` : '/app/domains'
}

export function parseExpiryWindow(value: string | undefined): ExpiryWindow | null {
  const number = Number(value)
  return (EXPIRY_WINDOWS as readonly number[]).includes(number) ? (number as ExpiryWindow) : null
}

/** Rows on one page of the portfolio: a phone on 4G renders 25 cards quickly (S10). */
export const PAGE_SIZE = 25

export type PortfolioPage<T> = {
  items: T[]
  /** The page shown: the one asked for, kept between the first and the last. */
  page: number
  pageCount: number
  /** 1-based positions of the first and last row shown, for "26–50 of 60". */
  from: number
  to: number
  total: number
}

/** One page of the filtered list. A page past the end shows the last one. */
export function paginate<T>(rows: T[], page: number, size = PAGE_SIZE): PortfolioPage<T> {
  const pageCount = Math.max(1, Math.ceil(rows.length / size))
  const current = Math.min(Math.max(1, page), pageCount)
  const start = (current - 1) * size
  const items = rows.slice(start, start + size)
  return {
    items,
    page: current,
    pageCount,
    from: items.length > 0 ? start + 1 : 0,
    to: start + items.length,
    total: rows.length,
  }
}

export function parsePage(value: string | undefined): number {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 1 ? number : 1
}

/**
 * The page links to offer: every page up to seven, else always seven — the
 * first, the last, the current one's neighbours, and a gap for what is left
 * out. A gap never stands for a single page; that page is shown instead.
 */
export function pageNumbers(
  page: number,
  pageCount: number,
): Array<number | 'gap-start' | 'gap-end'> {
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, index) => from + index)
  if (pageCount <= 7) return range(1, pageCount)
  let first = Math.max(2, Math.min(page - 1, pageCount - 4))
  let last = Math.min(pageCount - 1, Math.max(page + 1, 5))
  if (first === 3) first = 2
  if (last === pageCount - 2) last = pageCount - 1
  return [
    1,
    ...(first > 2 ? (['gap-start'] as const) : []),
    ...range(first, last),
    ...(last < pageCount - 1 ? (['gap-end'] as const) : []),
    pageCount,
  ]
}

export const DELEGATION_LABEL: Record<DelegationStatus, string> = {
  undelegated: 'Not pointed at your host yet',
  pending: 'Waiting to take effect',
  verified: 'Pointed and working',
  failed: 'Not working',
}
