import { formatNaira } from '@dr/shared'
import Link from 'next/link'
import { PricingUnavailable } from '@/features/pricing/components/pricing-unavailable'
import { FEATURED_TLDS, getPricedCatalogue } from '@/features/pricing/queries/pricing'

/**
 * Decorative wash per card — stands in for the reference's photography.
 * Uses dedicated tokens rather than --primary, which inverts between themes
 * and would turn a deep navy card near-white in dark mode.
 */
const WASH = [
  'from-wash-1-from to-wash-1-to',
  'from-wash-2-from to-wash-2-to',
  'from-wash-3-from to-wash-3-to',
] as const

export async function PopularExtensions() {
  const priced = await getPricedCatalogue()

  const tlds = FEATURED_TLDS.flatMap(({ tld, blurb }) => {
    const entry = priced?.tlds.find((t) => t.tld === tld)
    if (!entry) return []
    return [
      {
        tld,
        blurb,
        firstYear: formatNaira(entry.registration.priceKobo),
        renewal: formatNaira(entry.renewal.priceKobo),
        renewalIsHigher: entry.renewalIsHigher,
      },
    ]
  })

  return (
    <section aria-labelledby="popular-extensions">
      <h2 id="popular-extensions" className="text-xl font-bold tracking-tight sm:text-2xl">
        Popular extensions
      </h2>

      {tlds.length === 0 ? (
        <div className="mt-6 max-w-xl">
          <PricingUnavailable />
        </div>
      ) : null}

      <ul className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {tlds.map((item, index) => (
          <li key={item.tld}>
            <Link
              href={`/domains/${item.tld}`}
              className="group block rounded-xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
            >
              <div
                className={`relative grid h-28 place-items-center overflow-hidden rounded-xl bg-gradient-to-br ${WASH[index % WASH.length]}`}
              >
                <span className="text-3xl font-bold tracking-tight text-wash-foreground">
                  .{item.tld}
                </span>
                <span className="absolute right-3 bottom-3 rounded-full bg-background/95 px-2.5 py-1 text-[0.6875rem] font-medium text-foreground">
                  {item.firstYear}/yr
                </span>
              </div>

              <p className="mt-3 font-semibold text-foreground group-hover:underline">
                .{item.tld}
              </p>
              <p className="text-sm text-muted-foreground">{item.blurb}</p>
              {/* N8 — the renewal price is never hidden. */}
              <p className="mt-1 text-sm text-muted-foreground">
                Renews at{' '}
                <span className={item.renewalIsHigher ? 'font-medium text-foreground' : undefined}>
                  {item.renewal}/yr
                </span>
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
