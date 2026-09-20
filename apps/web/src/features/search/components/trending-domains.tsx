/**
 * Placeholder content until the search-volume table exists. Structure is real;
 * the rows are illustrative and marked as such in the caption.
 */
const TRENDING = [
  { rank: 1, tld: '.com.ng', detail: 'Most registered this month' },
  { rank: 2, tld: '.ng', detail: 'Fastest growing' },
  { rank: 3, tld: '.africa', detail: 'Rising across the continent' },
] as const

export function TrendingDomains() {
  return (
    <section aria-labelledby="trending" className="lg:pl-4">
      <h2 id="trending" className="text-xl font-bold tracking-tight sm:text-2xl">
        Trending this week
      </h2>

      <ol className="mt-6 space-y-5">
        {TRENDING.map((item) => (
          <li key={item.tld} className="flex items-center gap-4">
            <span
              aria-hidden="true"
              className="grid size-9 shrink-0 place-items-center rounded-full border border-border text-sm font-medium text-muted-foreground"
            >
              {item.rank}
            </span>
            <span className="min-w-0">
              <span className="block font-semibold text-foreground">{item.tld}</span>
              <span className="block text-sm text-muted-foreground">{item.detail}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}
