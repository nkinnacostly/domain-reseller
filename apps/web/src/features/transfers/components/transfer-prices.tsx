import { formatNaira } from '@dr/shared'
import { ArrowUpRight } from 'lucide-react'
import Link from 'next/link'
import { Container } from '@/components/layout/site-shell'
import { PricingUnavailable } from '@/features/pricing/components/pricing-unavailable'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'

/**
 * Transfer prices for the featured extensions — the same rows, in the same
 * order, as the rest of the site (tlds.featured_rank). Read from the one
 * pricing path, so this page cannot disagree with /pricing.
 */
export async function TransferPrices() {
  const priced = await getPricedCatalogue()
  const rows = (priced?.featured ?? []).flatMap((entry) =>
    entry.transfer
      ? [
          {
            tld: entry.tld,
            transfer: formatNaira(entry.transfer.priceKobo),
            renewal: formatNaira(entry.renewal.priceKobo),
          },
        ]
      : [],
  )

  return (
    <section aria-labelledby="transfer-prices-heading">
      <Container className="py-16 sm:py-24">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-2xl">
            <h2
              id="transfer-prices-heading"
              className="text-3xl font-bold tracking-tight text-balance sm:text-4xl"
            >
              What a transfer costs
            </h2>
            <p className="mt-4 text-pretty text-muted-foreground">
              In naira, before VAT, with the renewal price beside it — the number you will pay every
              year after.
            </p>
          </div>
          <Link
            href="/pricing"
            className="inline-flex items-center gap-1 text-sm font-medium text-brand-ink underline-offset-4 hover:underline focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Every extension
            <ArrowUpRight className="size-4" aria-hidden="true" />
          </Link>
        </div>

        {rows.length === 0 ? (
          <div className="mt-8 max-w-2xl">
            <PricingUnavailable />
          </div>
        ) : (
          <ul
            aria-label="Transfer prices"
            className="mt-10 grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-3 xl:grid-cols-6"
          >
            {rows.map((row) => (
              <li
                key={row.tld}
                className="min-w-0 rounded-3xl border border-border bg-card p-4 shadow-[0_18px_40px_-28px_rgb(0_0_0/0.35)] sm:p-6"
              >
                <p className="text-lg font-bold tracking-tight text-foreground">.{row.tld}</p>
                <p className="mt-3 text-xl font-bold tracking-tight text-foreground tabular-nums">
                  {row.transfer}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">Renews at {row.renewal}/yr</p>
              </li>
            ))}
          </ul>
        )}
      </Container>
    </section>
  )
}
