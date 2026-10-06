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
 * (N5b). Without them it says less, never a guess.
 */
export function PlansTeaser({ catalogue }: { catalogue: PlanCatalogue | null }) {
  const free = catalogue ? freePlan(catalogue.plans) : null
  const paid = catalogue ? cheapestPaid(catalogue.plans) : null

  return (
    <section aria-labelledby="plans-teaser-heading">
      <Container className="py-16 sm:py-24">
        <div className="grid gap-8 rounded-[2rem] border border-brand-subtle-border bg-card p-7 sm:p-10 lg:grid-cols-[1.4fr_1fr] lg:items-center">
          <div>
            <p className="text-sm font-semibold text-brand-ink">Pricing</p>
            <h2
              id="plans-teaser-heading"
              className="mt-2 text-3xl font-bold tracking-tight text-balance sm:text-4xl"
            >
              {free ? 'Start on the Free plan' : 'Plans with caps you can see'}
            </h2>
            <p className="mt-4 text-pretty text-muted-foreground">
              {free
                ? `${formatCount(free.monthlyCap)} emails a month, up to ${formatCount(free.dailyCap)} a day, for ${formatCount(free.maxDomains)} sending ${free.maxDomains === 1 ? 'domain' : 'domains'}. `
                : 'Every plan has a monthly and a daily cap, counted per recipient. '}
              {paid
                ? `Paid plans from ${planPrice(paid)} a month before VAT; VAT ${BUSINESS.vatRate} is added at checkout.`
                : null}
            </p>
          </div>
          <div className="lg:justify-self-end">
            <Link
              href={ROUTES.pricing}
              className="inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-7 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
            >
              Compare plans
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
          </div>
        </div>
      </Container>
    </section>
  )
}
