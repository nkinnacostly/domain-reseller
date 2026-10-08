import { ArrowRight } from 'lucide-react'
import Link from 'next/link'
import { Container } from '@/components/layout/container'
import {
  cheapestPaid,
  formatCount,
  freePlan,
  type PlanCatalogue,
  planPrice,
} from '@/features/pricing/lib/plans'
import { BUSINESS } from '@/lib/business'
import { ROUTES } from '../lib/site'

/**
 * The home page's word on price, read from the same plan rows as /pricing
 * (N5b). It leads with the Free plan (owner, 8 Oct 2026): what it costs and
 * what it sends, then where paid plans start. Without the rows it says less,
 * never a guess.
 */
export function PlansTeaser({ catalogue }: { catalogue: PlanCatalogue | null }) {
  const free = catalogue ? freePlan(catalogue.plans) : null
  const paid = catalogue ? cheapestPaid(catalogue.plans) : null
  const facts: [string, string][] = free
    ? [
        ['₦0', 'a month'],
        [formatCount(free.dailyCap), 'emails a day'],
        [formatCount(free.monthlyCap), 'emails a month'],
        [
          formatCount(free.maxDomains),
          free.maxDomains === 1 ? 'sending domain' : 'sending domains',
        ],
      ]
    : []

  return (
    <section aria-labelledby="plans-teaser-heading">
      <Container className="py-16 sm:py-24">
        <div className="rounded-[2rem] border border-brand-subtle-border bg-card p-7 sm:p-10">
          <div className="grid gap-8 lg:grid-cols-[1.3fr_1fr] lg:items-center">
            <div>
              <p className="text-sm font-semibold text-brand-ink">Pricing</p>
              <h2
                id="plans-teaser-heading"
                className="mt-2 text-3xl font-bold tracking-tight text-balance sm:text-4xl"
              >
                {free ? 'Start free, upgrade when you grow' : 'Plans with caps you can see'}
              </h2>
              <p className="mt-4 text-pretty text-muted-foreground">
                {free
                  ? `The Free plan sends ${formatCount(free.monthlyCap)} emails a month, up to ${formatCount(free.dailyCap)} a day, for ${formatCount(free.maxDomains)} sending ${free.maxDomains === 1 ? 'domain' : 'domains'}. No card needed. `
                  : 'Every plan has a monthly and a daily cap, counted per recipient. '}
                {paid
                  ? `Paid plans from ${planPrice(paid)} a month before VAT; VAT ${BUSINESS.vatRate} is added at checkout.`
                  : null}
              </p>
              <div className="mt-7 flex flex-col gap-3 sm:flex-row">
                {free ? (
                  <Link
                    href={ROUTES.signUp}
                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-primary px-7 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
                  >
                    Start free
                    <ArrowRight aria-hidden="true" className="size-4" />
                  </Link>
                ) : null}
                <Link
                  href={ROUTES.pricing}
                  className={
                    free
                      ? 'inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-border bg-background px-7 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]'
                      : 'inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-primary px-7 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]'
                  }
                >
                  Compare plans
                  {free ? null : <ArrowRight aria-hidden="true" className="size-4" />}
                </Link>
              </div>
            </div>
            {free ? (
              <dl aria-label="The Free plan" className="grid grid-cols-2 gap-3">
                {facts.map(([value, label]) => (
                  <div key={label} className="rounded-2xl bg-brand-subtle px-5 py-4 text-brand-ink">
                    <dt className="sr-only">{label}</dt>
                    <dd>
                      <span className="block text-2xl font-bold tracking-tight sm:text-3xl">
                        {value}
                      </span>
                      <span className="mt-1 block text-sm">{label}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        </div>
      </Container>
    </section>
  )
}
