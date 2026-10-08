import { EnvelopeSimpleOpen } from '@phosphor-icons/react/ssr'
import Link from 'next/link'
import { Container } from '@/components/layout/container'
import { BUSINESS } from '@/lib/business'
import { ROUTES } from '../lib/site'
import { ON_BRAND_PRIMARY, ON_BRAND_SECONDARY } from './hero'
import { IconDisc } from './page-hero'

/** The closing call to action, on the blue panel; "Start free" while there is a Free plan. */
export function FinalCta({ hasFreePlan = false }: { hasFreePlan?: boolean } = {}) {
  return (
    <section aria-labelledby="final-cta-heading">
      <Container className="pb-16 sm:pb-24">
        <div className="relative overflow-hidden rounded-[2rem] bg-brand px-6 py-12 text-brand-foreground sm:rounded-[2.5rem] sm:px-12 sm:py-16 lg:px-16">
          <div
            aria-hidden="true"
            // Behind the icon only; over the text it would cost contrast.
            className="absolute -right-24 -bottom-40 hidden size-[28rem] rounded-full bg-brand-arc/55 lg:block"
          />
          <div className="relative grid items-center gap-10 lg:grid-cols-[1.5fr_1fr]">
            <div>
              <h2
                id="final-cta-heading"
                className="text-3xl font-bold tracking-tight text-balance sm:text-4xl"
              >
                Send your first email
              </h2>
              <p className="mt-4 max-w-lg text-pretty text-brand-muted-foreground">
                Create an account{hasFreePlan ? ' on the Free plan — no card needed' : ''}, verify
                your domain and make one call, or point your app’s SMTP settings at us. Questions
                first? Email{' '}
                <a
                  href={`mailto:${BUSINESS.email}`}
                  className="rounded-sm font-medium text-brand-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-foreground"
                >
                  {BUSINESS.email}
                </a>
                .
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Link href={ROUTES.signUp} className={ON_BRAND_PRIMARY}>
                  {hasFreePlan ? 'Start free' : 'Get started'}
                </Link>
                <Link href={ROUTES.docs} className={ON_BRAND_SECONDARY}>
                  Read the docs
                </Link>
              </div>
            </div>
            <div aria-hidden="true" className="hidden justify-self-center lg:block">
              <IconDisc icon={EnvelopeSimpleOpen} className="size-40" />
            </div>
          </div>
        </div>
      </Container>
    </section>
  )
}
