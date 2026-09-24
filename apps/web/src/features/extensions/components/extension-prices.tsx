import { ArrowUpRight } from 'lucide-react'
import Link from 'next/link'
import { Container } from '@/components/layout/site-shell'
import { PricingUnavailable } from '@/features/pricing/components/pricing-unavailable'
import type { ExtensionPrices as Prices } from '../lib/extension'

/**
 * What an extension costs, from the one pricing path (N5b). The renewal price
 * sits beside the first-year price at the same size (N8, FR-S2); when prices
 * are withheld, nothing is shown in their place.
 */
export function ExtensionPrices({
  tld,
  prices,
  vatPct,
  isCountryCode,
}: {
  tld: string
  prices: Prices | null
  vatPct: number | null
  isCountryCode: boolean
}) {
  const cards = prices
    ? [
        { label: 'First year', value: prices.register, note: 'To register it today' },
        {
          label: 'Renewal',
          value: prices.renew,
          note: prices.renewalIsHigher
            ? 'Every year after — more than the first year'
            : 'Every year after',
        },
        {
          label: 'Transfer in',
          value: prices.transfer,
          note: prices.transfer
            ? 'To bring one you already own'
            : `We can't currently transfer .${tld} domains in`,
        },
      ]
    : []

  return (
    <section aria-labelledby="extension-prices-heading">
      <Container className="py-16 sm:py-24">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-2xl">
            <h2
              id="extension-prices-heading"
              className="text-3xl font-bold tracking-tight text-balance sm:text-4xl"
            >
              What a .{tld} domain costs
            </h2>
            <p className="mt-4 text-pretty text-muted-foreground">
              In naira, per year, with the renewal price beside the first-year price.
            </p>
          </div>
          <Link
            href="/pricing"
            className="inline-flex items-center gap-1 rounded-sm text-sm font-medium text-brand-ink underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Compare every extension
            <ArrowUpRight className="size-4" aria-hidden="true" />
          </Link>
        </div>

        {prices ? (
          <>
            <dl className="mt-10 grid gap-5 sm:grid-cols-3">
              {cards.map((card) => (
                <div
                  key={card.label}
                  className="min-w-0 rounded-3xl border border-border bg-card p-6 shadow-[0_18px_40px_-28px_rgb(0_0_0/0.35)]"
                >
                  <dt className="text-sm font-medium text-muted-foreground">{card.label}</dt>
                  <dd className="mt-2 text-3xl font-bold tracking-tight text-foreground tabular-nums">
                    {card.value ?? '—'}
                  </dd>
                  <dd className="mt-1 text-sm text-muted-foreground">{card.note}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-6 max-w-2xl text-pretty text-sm/6 text-muted-foreground">
              Before VAT{vatPct === null ? '' : ` at ${vatPct}%`}, which is added at checkout as its
              own line.{' '}
              {isCountryCode
                ? `Country-code extensions such as .${tld} carry no ICANN fee.`
                : 'The yearly ICANN fee on generic extensions is already included.'}
            </p>
          </>
        ) : (
          <div className="mt-10 max-w-2xl">
            <PricingUnavailable />
          </div>
        )}
      </Container>
    </section>
  )
}
