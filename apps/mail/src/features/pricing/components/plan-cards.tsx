import { Check } from 'lucide-react'
import Link from 'next/link'
import { Container } from '@/components/layout/container'
import { LAUNCH, ROUTES } from '@/features/marketing/lib/site'
import { BUSINESS } from '@/lib/business'
import { isFree, type PlanCatalogue, planFeatures, planPrice } from '../lib/plans'

const MAIL_LINK =
  'rounded-sm font-medium text-brand-ink underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/**
 * The offered plans, one card each (MAIL-SPEC §8): the monthly price before
 * VAT, then every cap and limit — N8 for Mail. Four states (S11): the page
 * prerenders, so there is no loading state to show; a failed read withholds
 * prices (N5b) and says what to do; no offered plan says so; otherwise the
 * cards.
 */
export function PlanCards({
  catalogue,
  paidPlansOnSale = LAUNCH.paidPlansOnSale,
}: {
  catalogue: PlanCatalogue | null
  paidPlansOnSale?: boolean
}) {
  return (
    <section aria-labelledby="plans-heading">
      <Container className="py-12 sm:py-16">
        <h2 id="plans-heading" className="text-2xl font-bold tracking-tight sm:text-3xl">
          The plans
        </h2>

        {catalogue === null ? (
          <div
            role="status"
            className="mt-6 max-w-2xl rounded-3xl border border-border bg-card p-6 text-sm/6"
          >
            <p className="font-medium text-foreground">The plans could not be loaded just now.</p>
            <p className="mt-2 text-muted-foreground">
              We only show prices read from our records, never a guess. Reload the page in a few
              minutes, or email{' '}
              <a href={`mailto:${BUSINESS.email}`} className={MAIL_LINK}>
                {BUSINESS.email}
              </a>{' '}
              and we will send them to you.
            </p>
          </div>
        ) : catalogue.plans.length === 0 ? (
          <div
            role="status"
            className="mt-6 max-w-2xl rounded-3xl border border-border bg-card p-6 text-sm/6"
          >
            <p className="font-medium text-foreground">No plans are on offer right now.</p>
            <p className="mt-2 text-muted-foreground">
              Email{' '}
              <a href={`mailto:${BUSINESS.email}`} className={MAIL_LINK}>
                {BUSINESS.email}
              </a>{' '}
              and we will tell you when they are.
            </p>
          </div>
        ) : (
          <>
            <ul aria-label="Plans" className="mt-8 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {catalogue.plans.map((plan) => (
                <li
                  key={plan.code}
                  data-plan={plan.code}
                  className="flex flex-col rounded-[2rem] border border-brand-subtle-border bg-card p-7 shadow-[0_18px_40px_-28px_rgb(0_0_0/0.35)]"
                >
                  <h3 className="text-lg font-semibold tracking-tight">{plan.name}</h3>
                  <p className="mt-4 flex flex-wrap items-baseline gap-x-2">
                    <span data-testid="plan-price" className="text-4xl font-bold tracking-tight">
                      {planPrice(plan)}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {isFree(plan) ? 'a month' : 'a month, before VAT'}
                    </span>
                  </p>
                  <ul className="mt-6 space-y-3 text-sm">
                    {planFeatures(plan).map((feature) => (
                      <li key={feature} className="flex gap-3">
                        <Check
                          aria-hidden="true"
                          className="mt-0.5 size-4 shrink-0 text-brand-ink"
                        />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-auto pt-8">
                    {isFree(plan) || paidPlansOnSale ? (
                      <Link
                        href={ROUTES.signUp}
                        className="inline-flex min-h-11 w-full items-center justify-center rounded-full bg-primary px-6 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
                      >
                        {isFree(plan) ? 'Start free' : `Choose ${plan.name}`}
                      </Link>
                    ) : (
                      <p className="flex min-h-11 items-center justify-center rounded-full border border-dashed border-border px-6 text-sm text-muted-foreground">
                        Not on sale yet
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-6 text-sm text-muted-foreground">
              Prices are for a month, before VAT. VAT {BUSINESS.vatRate} is added at checkout.
            </p>
          </>
        )}
      </Container>
    </section>
  )
}
