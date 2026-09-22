import { formatNaira } from '@dr/shared'
import Link from 'next/link'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'

/**
 * The featured extensions after the first three, with their live price.
 *
 * This used to be a "Trending this week" list with invented rankings. We have
 * no search-volume data yet, so the section says what it really is: our pick,
 * ordered by `tlds.featured_rank`.
 */
export async function TrendingDomains() {
  const priced = await getPricedCatalogue()
  const picks = priced?.featured.slice(3, 6) ?? []

  if (picks.length === 0) return null

  return (
    <section aria-labelledby="worth-a-look" className="lg:pl-4">
      <h2 id="worth-a-look" className="text-xl font-bold tracking-tight sm:text-2xl">
        Also worth a look
      </h2>

      <ol className="mt-6 space-y-5">
        {picks.map((item, index) => (
          <li key={item.tld}>
            <Link
              href={`/domains/${item.tld}`}
              className="group flex items-center gap-4 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
            >
              <span
                aria-hidden="true"
                className="grid size-9 shrink-0 place-items-center rounded-full border border-border text-sm font-medium text-muted-foreground transition-colors group-hover:border-foreground group-hover:text-foreground"
              >
                {index + 1}
              </span>
              <span className="min-w-0">
                <span className="block font-semibold text-foreground group-hover:underline">
                  .{item.tld}{' '}
                  <span className="font-normal text-muted-foreground text-sm">
                    from {formatNaira(item.registration.priceKobo)}/yr
                  </span>
                </span>
                {item.tagline ? (
                  <span className="block text-sm text-muted-foreground">{item.tagline}</span>
                ) : null}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  )
}
