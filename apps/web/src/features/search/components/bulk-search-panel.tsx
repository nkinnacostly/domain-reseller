import { PricingUnavailable } from '@/features/pricing/components/pricing-unavailable'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { BULK_MAX_EXTENSIONS, pickDefaultTlds, splitNames } from '../lib/bulk'
import { getLengthRules } from '../queries/length-rules'
import { BulkSearchForm } from './bulk-search-form'

type BulkParams = Promise<{ names?: string | string[]; tld?: string | string[] }>

/** Room for 500 long names; a bound on work done for a pasted novel. */
const MAX_INPUT_CHARS = 40_000

async function readBulkParams(searchParams: BulkParams) {
  const { names, tld } = await searchParams
  const text = (Array.isArray(names) ? names.join('\n') : (names ?? '')).slice(0, MAX_INPUT_CHARS)
  const picked = tld === undefined ? [] : Array.isArray(tld) ? tld : [tld]
  return { names: splitNames(text), picked }
}

/**
 * The bulk search form, on the hero (FR-S5). It reads the address — names
 * sent before the page was ready, or a link someone kept — so it sits in its
 * own Suspense boundary on the page. Everything a list is checked against
 * here (what we sell, FR-S9 length rules) comes from the cached catalogue.
 */
export async function BulkSearchPanel({ searchParams }: { searchParams: BulkParams }) {
  const [{ names, picked }, priced, lengthRules] = await Promise.all([
    readBulkParams(searchParams),
    getPricedCatalogue(),
    getLengthRules(),
  ])
  // No catalogue, no prices — and a result without a price breaks N8.
  if (!priced) {
    return (
      <div className="rounded-3xl bg-background text-foreground">
        <PricingUnavailable />
      </div>
    )
  }

  const sold = priced.tlds.map((tld) => tld.tld)
  const soldSet = new Set(sold)
  const featured = priced.featured.map((tld) => tld.tld)
  const extensions = featured.filter((tld) => soldSet.has(tld)).slice(0, BULK_MAX_EXTENSIONS)

  return (
    <BulkSearchForm
      extensions={extensions}
      sold={sold}
      featured={featured}
      lengthRules={lengthRules}
      defaultNames={names.join('\n')}
      defaultPicked={pickDefaultTlds(picked, soldSet, extensions)}
      autoRun={names.length > 0}
    />
  )
}

export function BulkSearchPanelSkeleton() {
  return (
    <div aria-hidden="true" className="h-96 animate-pulse rounded-3xl bg-brand-foreground/20" />
  )
}
