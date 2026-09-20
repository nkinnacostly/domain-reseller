import type { PublicPriceRow } from '../lib/public-row'

/**
 * The Nigerian range, led on the page because it is where we are actually
 * competitive and where the flat-price promise holds.
 */
export function FeaturedPricing({ rows }: { rows: PublicPriceRow[] }) {
  if (rows.length === 0) return null

  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {rows.map((row) => (
        <li key={row.tld} className="rounded-2xl border border-border bg-background p-5 sm:p-6">
          <p className="text-xl font-bold tracking-tight text-foreground">{`.${row.tld}`}</p>

          <p className="mt-4 text-2xl font-bold tracking-tight text-foreground tabular-nums">
            {row.register}
            <span className="ml-1 text-sm font-normal text-muted-foreground">/yr</span>
          </p>

          <p className="mt-2 text-sm text-muted-foreground">
            {row.renewalIsHigher ? (
              <>Renews at {row.renew}/yr</>
            ) : (
              <span className="font-medium text-accent">Same price every year</span>
            )}
          </p>

          <p className="mt-4 text-xs text-muted-foreground">
            Up to {row.maxPeriod} years · no ICANN fee
          </p>
        </li>
      ))}
    </ul>
  )
}
