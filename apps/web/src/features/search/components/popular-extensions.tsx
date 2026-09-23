import { formatNaira } from '@dr/shared'
import { ArrowRight } from 'lucide-react'
import Link from 'next/link'
import { Container } from '@/components/layout/site-shell'
import { PricingUnavailable } from '@/features/pricing/components/pricing-unavailable'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'

/**
 * The featured extensions, ranked by `tlds.featured_rank` — what leads is a
 * data change, not a deploy. Every card carries its renewal price (N8); this
 * replaced a "trending" list that showed first-year prices alone. Cards open
 * the extension's row on the pricing page: there are no per-extension pages.
 */
export async function PopularExtensions() {
  const priced = await getPricedCatalogue()

  const tlds = (priced?.featured.slice(0, 6) ?? []).map((entry) => ({
    tld: entry.tld,
    blurb: entry.tagline,
    firstYear: formatNaira(entry.registration.priceKobo),
    renewal: formatNaira(entry.renewal.priceKobo),
    renewalIsHigher: entry.renewalIsHigher,
  }))

  return (
    <section aria-labelledby="popular-extensions">
      <Container className="py-16 sm:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <h2
            id="popular-extensions"
            className="text-3xl font-bold tracking-tight text-balance sm:text-4xl lg:text-5xl"
          >
            Popular extensions
          </h2>
          <p className="mt-4 text-pretty text-muted-foreground">
            In naira, before VAT, with what each one renews at.
          </p>
        </div>

        {tlds.length === 0 ? (
          <div className="mx-auto mt-10 max-w-xl">
            <PricingUnavailable />
          </div>
        ) : (
          <ul className="mt-12 grid gap-5 sm:mt-16 sm:grid-cols-2 lg:grid-cols-3 lg:gap-6">
            {tlds.map((item) => (
              <li key={item.tld}>
                <Link
                  href={`/pricing#tld-${item.tld}`}
                  className="group flex h-full flex-col rounded-[2rem] border border-border bg-card p-7 shadow-[0_18px_40px_-28px_rgb(0_0_0/0.35)] transition-colors hover:border-brand-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
                >
                  <div className="mb-6">
                    <h3 className="text-3xl font-bold tracking-tight text-foreground">
                      .{item.tld}
                    </h3>
                    {item.blurb ? (
                      <p className="mt-2 text-pretty text-sm text-muted-foreground">{item.blurb}</p>
                    ) : null}
                  </div>

                  <div className="mt-auto flex items-end justify-between gap-4 border-border border-t pt-5">
                    <p className="text-sm text-muted-foreground">
                      <span className="block text-2xl font-bold tracking-tight text-foreground">
                        {item.firstYear}
                        <span className="text-sm font-normal text-muted-foreground">/yr</span>
                      </span>
                      {/* N8 — the renewal price is never hidden. */}
                      Renews at{' '}
                      <span
                        className={item.renewalIsHigher ? 'font-medium text-foreground' : undefined}
                      >
                        {item.renewal}/yr
                      </span>
                    </p>
                    <span className="grid size-11 shrink-0 place-items-center rounded-full bg-brand-subtle text-brand-ink transition-colors group-hover:bg-brand group-hover:text-brand-foreground">
                      <ArrowRight className="size-4" aria-hidden="true" />
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {priced ? (
          <div className="mt-10 text-center">
            <Link
              href="/pricing"
              className="inline-flex items-center gap-2 rounded-sm text-sm font-medium text-brand-ink underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
            >
              See all {priced.tlds.length.toLocaleString('en-NG')} prices
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </div>
        ) : null}
      </Container>
    </section>
  )
}
