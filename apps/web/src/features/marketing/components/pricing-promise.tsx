import { Container } from '@/components/layout/site-shell'
import { EFFECTIVE_RATE } from '@/features/pricing/lib/fx'

/**
 * The FX policy, stated plainly (PRD FR-FX-3). Publishing this is the point —
 * every incumbent hides the conversion inside the price.
 */
export function PricingPromise() {
  return (
    <section aria-labelledby="pricing-promise-heading">
      <Container className="py-14 sm:py-20">
        <div className="grid gap-10 rounded-2xl bg-gradient-to-br from-hero-from to-hero-to p-7 sm:p-10 lg:grid-cols-[1.1fr_1fr] lg:gap-16 lg:p-14">
          <div>
            <h2
              id="pricing-promise-heading"
              className="text-2xl font-bold tracking-tight text-balance sm:text-3xl"
            >
              How we work out your price
            </h2>
            <p className="mt-4 text-pretty text-muted-foreground">
              Domains are bought from registries in US dollars and sold to you in naira. Most
              registrars hide the conversion. Here is ours, in full.
            </p>
          </div>

          <dl className="space-y-6">
            <div className="border-border/70 border-b pb-5">
              <dt className="font-semibold text-foreground">One published rate</dt>
              <dd className="mt-1.5 text-sm/6 text-muted-foreground">
                We convert at a fixed rate of ₦{EFFECTIVE_RATE.toLocaleString('en-NG')} to the
                dollar, stated on the pricing page rather than buried in the total.
              </dd>
            </div>
            <div className="border-border/70 border-b pb-5">
              <dt className="font-semibold text-foreground">It does not move on you</dt>
              <dd className="mt-1.5 text-sm/6 text-muted-foreground">
                The rate holds between reviews, so a domain you priced at breakfast costs the same
                at close of business. When it changes, we say so.
              </dd>
            </div>
            <div>
              <dt className="font-semibold text-foreground">Locked while you check out</dt>
              <dd className="mt-1.5 text-sm/6 text-muted-foreground">
                Once a domain is in your cart the price is held for 30 minutes. If it does change
                after that, we show you what changed before you pay — never after.
              </dd>
            </div>
          </dl>
        </div>
      </Container>
    </section>
  )
}
