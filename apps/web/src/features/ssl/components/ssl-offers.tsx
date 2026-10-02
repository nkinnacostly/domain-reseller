import { ShieldCheck } from 'lucide-react'
import { Container } from '@/components/layout/site-shell'
import { PricingUnavailable } from '@/features/pricing/components/pricing-unavailable'
import type { SslOffer } from '../lib/offers'
import { AddCertificateForm } from './add-certificate-form'

/**
 * FR-SSL-1, FR-SSL-2: the certificates we sell, each with its price, its term
 * and what buying again costs (N8), and a box for the name it is for.
 */
export function SslOffers({
  offers,
  vatPct,
}: {
  offers: SslOffer[] | null
  vatPct: number | null
}) {
  return (
    <section aria-labelledby="ssl-offers-heading">
      <Container className="py-16 sm:py-24">
        <div className="max-w-2xl">
          <h2
            id="ssl-offers-heading"
            className="text-3xl font-bold tracking-tight text-balance sm:text-4xl"
          >
            Three certificates, from Sectigo
          </h2>
          <p className="mt-4 text-pretty text-muted-foreground">
            Domain-validated (DV): the certificate authority checks you control the domain by
            emailing an address there. In naira, before VAT{vatPct !== null ? ` (${vatPct}%)` : ''},
            which checkout adds.
          </p>
        </div>

        {offers === null || offers.length === 0 ? (
          <div className="mt-8 max-w-2xl">
            <PricingUnavailable />
          </div>
        ) : (
          <ul aria-label="SSL certificates" className="mt-10 grid gap-5 lg:grid-cols-3">
            {offers.map((offer) => (
              <li
                key={offer.productCode}
                data-product={offer.productCode}
                className="flex min-w-0 flex-col rounded-3xl border border-border bg-card p-5 shadow-[0_18px_40px_-28px_rgb(0_0_0/0.35)] sm:p-7"
              >
                <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <ShieldCheck className="size-4" aria-hidden="true" />
                  {offer.kind === 'wildcard'
                    ? 'Wildcard'
                    : offer.kind === 'multi'
                      ? 'Several names'
                      : 'One name'}
                </p>
                <h3 className="mt-2 text-xl font-bold tracking-tight text-foreground">
                  {offer.name}
                </h3>
                <p className="mt-2 text-pretty text-sm/6 text-muted-foreground">{offer.covers}</p>
                <p className="mt-5 text-3xl font-bold tracking-tight text-foreground tabular-nums">
                  {offer.price}
                </p>
                <p className="text-sm text-muted-foreground">{offer.term}</p>
                <p className="mt-2 text-pretty text-xs/5 text-muted-foreground">{offer.renewal}</p>
                <div className="mt-6 border-border border-t pt-5 lg:mt-auto">
                  <AddCertificateForm
                    productCode={offer.productCode}
                    productName={offer.name}
                    label={offer.nameLabel}
                    placeholder={offer.namePlaceholder}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Container>
    </section>
  )
}
