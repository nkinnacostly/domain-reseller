import { Gauge, HandPalm } from '@phosphor-icons/react/ssr'
import { Container } from '@/components/layout/container'
import { type Faq, FaqList } from '@/features/marketing/components/faq'
import { BUSINESS } from '@/lib/business'
import { CAP_RULES, COUNTING } from '../lib/copy'

const ICONS = [Gauge, HandPalm] as const

/** What happens at 80% and at 100% of a cap (MAIL-SPEC §8; N8 for Mail). */
export function CapRules() {
  return (
    <section aria-labelledby="caps-heading" className="bg-brand-subtle">
      <Container className="py-12 sm:py-16">
        <div className="max-w-2xl">
          <h2 id="caps-heading" className="text-2xl font-bold tracking-tight sm:text-3xl">
            What happens at a cap
          </h2>
          <p className="mt-3 text-pretty text-muted-foreground">
            Caps count recipients. {COUNTING}
          </p>
        </div>
        <ul className="mt-8 grid gap-6 md:grid-cols-2">
          {CAP_RULES.map((rule, index) => {
            const Icon = ICONS[index] ?? Gauge
            return (
              <li
                key={rule.level}
                className="flex gap-5 rounded-3xl border border-brand-subtle-border bg-card p-6"
              >
                <span
                  aria-hidden="true"
                  className="grid size-12 shrink-0 place-items-center rounded-2xl bg-brand-subtle"
                >
                  <Icon weight="duotone" className="size-6 text-brand-ink" />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-brand-ink">At {rule.level}</p>
                  <h3 className="mt-1 text-lg font-semibold tracking-tight">{rule.title}</h3>
                  <p className="mt-2 text-pretty text-sm/6 text-muted-foreground">{rule.body}</p>
                </div>
              </li>
            )
          })}
        </ul>
      </Container>
    </section>
  )
}

/** The questions under the plans, answers in the HTML. */
export function PricingFaq({ faqs }: { faqs: readonly Faq[] }) {
  return (
    <section aria-labelledby="pricing-faq-heading">
      <Container className="py-12 sm:py-16">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.6fr] lg:gap-16">
          <div>
            <h2
              id="pricing-faq-heading"
              className="text-2xl font-bold tracking-tight text-balance sm:text-3xl"
            >
              Questions about plans
            </h2>
            <p className="mt-3 text-pretty text-muted-foreground">
              Something else? Email{' '}
              <a
                href={`mailto:${BUSINESS.email}`}
                className="rounded-sm font-medium text-brand-ink underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {BUSINESS.email}
              </a>
              .
            </p>
          </div>
          <FaqList faqs={faqs} />
        </div>
      </Container>
    </section>
  )
}
