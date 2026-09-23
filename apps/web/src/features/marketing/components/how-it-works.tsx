import { ArrowRight, Check } from 'lucide-react'
import Link from 'next/link'
import { Container } from '@/components/layout/site-shell'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { PhoneFrame } from './phone-frame'
import { CheckoutScreen, NameserverScreen, type Quote, SearchScreen } from './phone-screens'

type Step = {
  id: string
  title: string
  body: string
  points: string[]
  link: { href: string; label: string }
  screen: React.ReactNode
  testId?: string
}

/**
 * Search, pay, point: one row per step, text and phone alternating sides.
 * Every statement here is something the product does today (N9b).
 */
export function HowItWorks({
  lead,
  more,
  vat,
  hosts,
  extensionCount,
  holdMinutes,
}: {
  lead: Quote | null
  more: Quote[]
  vat: { pct: number; amount: string; total: string } | null
  hosts: string[]
  extensionCount: number | null
  /** How long a cart holds its price (PRICE_LOCK_MINUTES). */
  holdMinutes: number
}) {
  const steps: Step[] = [
    {
      id: 'step-search',
      title: 'Search once, see both prices',
      body: 'Type a name and we check it across every extension we carry. Each result shows what the first year costs and what it renews at, so the second year is never a surprise.',
      points: [
        extensionCount
          ? `${extensionCount.toLocaleString('en-NG')} extensions, from .com to .africa`
          : 'Every extension we carry, in one search',
        'First-year and renewal price on every result',
      ],
      link: { href: '/pricing', label: 'See all prices' },
      screen: <SearchScreen lead={lead} more={more} />,
      testId: 'search-phone',
    },
    {
      id: 'step-pay',
      title: 'Pay in naira, your way',
      body: 'Pay by card, bank transfer or USSD through Flutterwave — no dollar card, no foreign-currency charge on your statement. VAT is its own line, shown before you pay.',
      points: [
        'Card, bank transfer or USSD',
        `Your price is held for ${holdMinutes} minutes once it is in your cart`,
      ],
      link: { href: '/help#buying', label: 'How buying works' },
      screen: <CheckoutScreen lead={lead} vat={vat} />,
    },
    {
      id: 'step-point',
      title: 'Point it at your host',
      body: 'Pick your host from the list and we fill in the nameservers, or paste the ones your host gave you. Then we show what public resolvers see, so you know the change has landed.',
      points: [
        hosts.length > 0
          ? `Ready-made for ${listFormat(hosts)}`
          : 'Paste the nameservers your host gave you',
        'Transfer lock on from the start',
      ],
      link: { href: '/help#pointing', label: 'How pointing works' },
      screen: <NameserverScreen lead={lead} hosts={hosts} />,
    },
  ]

  return (
    <section id="how-it-works" aria-labelledby="how-it-works-heading" className="scroll-mt-8">
      <Container className="py-16 sm:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold text-brand-ink">How it works</p>
          <h2
            id="how-it-works-heading"
            className="mt-2 text-3xl font-bold tracking-tight text-balance sm:text-4xl lg:text-5xl"
          >
            Three steps, no tutorial
          </h2>
          <p className="mt-4 text-pretty text-muted-foreground">
            Buying a domain should take a few minutes, not an afternoon of reading support articles.
          </p>
        </div>

        <ol className="mt-14 space-y-16 sm:mt-20 sm:space-y-24">
          {steps.map((step, index) => (
            <li key={step.id} className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
              <div className={cn('max-w-xl', index % 2 === 1 && 'lg:order-2')}>
                <p className="text-sm font-semibold text-brand-ink">Step {index + 1}</p>
                <h3 className="mt-2 text-2xl font-bold tracking-tight text-balance sm:text-3xl lg:text-4xl">
                  {step.title}
                </h3>
                <p className="mt-4 text-pretty text-muted-foreground">{step.body}</p>
                <ul className="mt-6 space-y-3">
                  {step.points.map((point) => (
                    <li key={point} className="flex gap-3 text-sm text-foreground">
                      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-brand-subtle text-brand-ink">
                        <Check className="size-3" strokeWidth={3} aria-hidden="true" />
                      </span>
                      {point}
                    </li>
                  ))}
                </ul>
                <Button
                  asChild
                  size="lg"
                  className="mt-8 h-12 rounded-full bg-accent px-6 text-accent-foreground hover:bg-accent/90"
                >
                  <Link href={step.link.href}>
                    {step.link.label}
                    <ArrowRight className="size-4" aria-hidden="true" />
                  </Link>
                </Button>
              </div>

              <div className="relative h-[26rem] overflow-hidden rounded-[2rem] border border-brand-subtle-border bg-brand-subtle sm:h-[30rem]">
                <div
                  aria-hidden="true"
                  className="absolute -top-16 -right-16 size-64 rounded-full bg-brand/10"
                />
                <div
                  aria-hidden="true"
                  className="absolute -bottom-20 -left-12 size-56 rounded-full bg-brand/10"
                />
                <PhoneFrame
                  testId={step.testId}
                  className="absolute top-10 left-1/2 -translate-x-1/2 sm:top-12"
                >
                  {step.screen}
                </PhoneFrame>
              </div>
            </li>
          ))}
        </ol>
      </Container>
    </section>
  )
}

function listFormat(items: string[]): string {
  return new Intl.ListFormat('en-NG', { style: 'long', type: 'conjunction' }).format(items)
}
