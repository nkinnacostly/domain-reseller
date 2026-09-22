import type { PublicPriceRow } from '../lib/public-row'

/**
 * The featured extensions, in the order `tlds.featured_rank` sets. Every claim
 * on the card is read from the row, so it holds for whatever is featured.
 */
export function FeaturedPricing({ rows, label }: { rows: PublicPriceRow[]; label: string }) {
  if (rows.length === 0) return null

  return (
    <ul aria-label={label} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {rows.map((row) => (
        <li key={row.tld} className="rounded-2xl border border-border bg-background p-5 sm:p-6">
          <p className="text-xl font-bold tracking-tight text-foreground">{`.${row.tld}`}</p>

          <p className="mt-4 text-2xl font-bold tracking-tight text-foreground tabular-nums">
            {row.register}
            <span className="ml-1 text-sm font-normal text-muted-foreground">/yr</span>
          </p>

          <p className="mt-2 text-sm text-muted-foreground">
            {row.renew === row.register ? (
              <span className="font-medium text-accent">Renews at the same price</span>
            ) : (
              <>Renews at {row.renew}/yr</>
            )}
          </p>

          <p className="mt-4 text-xs text-muted-foreground">
            Up to {row.maxPeriod} years ·{' '}
            {row.isCountryCode ? 'no ICANN fee' : 'ICANN fee included'}
          </p>
        </li>
      ))}
    </ul>
  )
}
