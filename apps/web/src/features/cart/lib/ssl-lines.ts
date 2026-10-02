import { bareName, type SslPricing } from '@dr/shared'
import type { LineStatus } from './lines'

/**
 * Pricing an SSL certificate in the cart (FR-SSL-6, FR-C4): the same lock as
 * a domain — the quote holds for the lock window, then today's price applies
 * and a change must be accepted. Pure: catalogue and clock come in.
 */

export type StoredSslLine = {
  id: string
  productCode: string
  /** The supplier name: example.com, or *.example.com for a wildcard. */
  commonName: string
  quotedTotalKobo: number
  quotedAt: string
}

export type SslLineKind = 'single' | 'wildcard' | 'multi'

export type PricedSslLine = StoredSslLine & {
  status: LineStatus
  productName: string
  kind: SslLineKind
  /** Names the certificate covers, the main one included. */
  includedNames: number
  payableKobo: number
  /** What a new certificate costs today: its "renewal" (N8). Never charged by itself. */
  renewalKobo: number
  currentKobo: number | null
  heldUntil: string | null
}

export function sslKind(product: Pick<SslPricing, 'isWildcard' | 'isMultiDomain'>): SslLineKind {
  if (product.isMultiDomain) return 'multi'
  return product.isWildcard ? 'wildcard' : 'single'
}

/** The site, as a person reads it: example.com — the `*.` is the product's to say. */
export function siteOf(line: Pick<StoredSslLine, 'commonName'>): string {
  return bareName(line.commonName)
}

export function priceSslLine(
  line: StoredSslLine,
  product: SslPricing | undefined,
  now: Date,
  lockMinutes: number,
): PricedSslLine {
  const heldUntil = new Date(new Date(line.quotedAt).getTime() + lockMinutes * 60_000)
  if (!product) {
    return {
      ...line,
      status: 'unavailable',
      productName: 'SSL certificate',
      kind: line.commonName.startsWith('*.') ? 'wildcard' : 'single',
      includedNames: 1,
      payableKobo: 0,
      renewalKobo: line.quotedTotalKobo,
      currentKobo: null,
      heldUntil: null,
    }
  }
  const current = product.price.priceKobo
  const base = {
    ...line,
    productName: product.name,
    kind: sslKind(product),
    includedNames: product.includedNames,
    renewalKobo: current,
    currentKobo: current,
  }
  if (now < heldUntil) {
    return {
      ...base,
      status: 'held',
      payableKobo: line.quotedTotalKobo,
      heldUntil: heldUntil.toISOString(),
    }
  }
  return {
    ...base,
    status: current === line.quotedTotalKobo ? 'current' : 'changed',
    payableKobo: current,
    heldUntil: null,
  }
}
