import Link from 'next/link'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { isAiEnabled } from '@/lib/ai'
import { NAME_FINDER_EXTENSIONS } from '../lib/name-ideas'
import { NameFinder } from './name-finder'

/**
 * The name finder with the extensions it can price today (N5b): none priced,
 * or no AI key, and the panel says so and points at search instead.
 */
export async function NameFinderPanel() {
  const priced = await getPricedCatalogue()
  const sold = new Set(priced?.tlds.map((tld) => tld.tld) ?? [])
  const extensions = NAME_FINDER_EXTENSIONS.filter((tld) => sold.has(tld))

  if (!isAiEnabled() || extensions.length === 0) {
    return (
      <div className="rounded-3xl bg-background p-5 text-foreground shadow-sm sm:p-6">
        <p className="font-medium">The name finder isn’t available right now.</p>
        <p className="mt-1.5 text-sm text-muted-foreground">
          <Link href="/search" className="font-medium text-foreground underline underline-offset-2">
            Search for a name you have in mind
          </Link>{' '}
          — every result shows its first-year and renewal price.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-3xl bg-background p-5 text-foreground shadow-sm sm:p-6">
      <NameFinder extensions={extensions} />
    </div>
  )
}

export function NameFinderPanelSkeleton() {
  return <div aria-hidden="true" className="h-64 animate-pulse rounded-3xl bg-background/70" />
}
