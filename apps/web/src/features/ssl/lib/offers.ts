import { formatNaira, SSL_TERM, type SslPricing } from '@dr/shared'
import { type SslLineKind, sslKind } from '@/features/cart/lib/ssl-lines'

/**
 * The certificates as the storefront shows them (FR-SSL-1, FR-SSL-2): what
 * each covers in plain words, its price, its term and what buying again
 * costs (N8). Pure — the catalogue comes in.
 */
export type SslOffer = {
  productCode: string
  name: string
  kind: SslLineKind
  /** One line on what it covers. */
  covers: string
  /** What to type into the box: a name, or the domain a wildcard sits under. */
  nameLabel: string
  namePlaceholder: string
  priceKobo: number
  price: string
  term: string
  renewal: string
}

const ORDER: Record<SslLineKind, number> = { single: 0, multi: 1, wildcard: 2 }

export function toSslOffers(products: readonly SslPricing[]): SslOffer[] {
  return [...products]
    .map((product): SslOffer => {
      const kind = sslKind(product)
      const price = formatNaira(product.price.priceKobo)
      return {
        productCode: product.productCode,
        name: product.name,
        kind,
        covers:
          kind === 'wildcard'
            ? 'Every name one level under your domain: *.example.com covers www.example.com, shop.example.com and the rest.'
            : kind === 'multi'
              ? `Up to ${product.includedNames} names under one domain — example.com, www.example.com, shop.example.com and so on.`
              : 'One name — example.com, or www.example.com, or shop.example.com.',
        nameLabel:
          kind === 'wildcard'
            ? 'Your domain'
            : kind === 'multi'
              ? 'Main name'
              : 'The name it is for',
        namePlaceholder: kind === 'single' ? 'www.example.com' : 'example.com',
        priceKobo: product.price.priceKobo,
        price,
        term: SSL_TERM.short,
        renewal: SSL_TERM.renewal(price),
      }
    })
    .sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.priceKobo - b.priceKobo)
}
