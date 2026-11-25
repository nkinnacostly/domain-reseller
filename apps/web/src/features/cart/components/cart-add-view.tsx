import { formatNaira } from '@dr/shared'
import Link from 'next/link'
import { PricingUnavailable } from '@/features/pricing/components/pricing-unavailable'
import { priceWithRenewal } from '@/features/pricing/lib/terms'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { toUnicodeHost } from '@/features/search/lib/idn'
import { parseSearchQuery } from '@/features/search/lib/query'
import { parseCartAddParam } from '../lib/add-link'
import { CartLinkAdd } from './cart-link-add'

export type CartAddSearch = Promise<{ d?: string | string[] }>

const LINK =
  'inline-flex h-11 items-center justify-center rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]'

/**
 * A cart link's page (feature 8): the names someone — often an AI assistant
 * — chose, each with its price and renewal price from our tables (N8).
 * Opening it adds nothing; the button does, after checking each name again.
 */
export async function CartAddView({ searchParams }: { searchParams: CartAddSearch }) {
  const names = parseCartAddParam((await searchParams).d)
  if (names.length === 0) {
    return (
      <div className="rounded-3xl border border-border border-dashed px-6 py-10 text-center">
        <p className="font-medium text-foreground">This link has no domains in it.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Search for a name to see whether it’s free.
        </p>
        <Link href="/search" className={`${LINK} mt-4`}>
          Search domains
        </Link>
      </div>
    )
  }
  const priced = await getPricedCatalogue()
  if (!priced) return <PricingUnavailable />
  const byTld = new Map(priced.tlds.map((pricing) => [pricing.tld, pricing]))
  const rows = names.map((raw) => {
    const { stem, tld, isValid } = parseSearchQuery(raw)
    const pricing = isValid && tld ? byTld.get(tld) : undefined
    if (!pricing) return { key: raw, shown: raw, ascii: null, words: null }
    const ascii = `${stem}.${tld}`
    return {
      key: ascii,
      shown: toUnicodeHost(ascii),
      ascii,
      words: priceWithRenewal(
        pricing.tld,
        { price: formatNaira(pricing.firstTerm.priceKobo), years: pricing.firstTerm.years },
        { price: formatNaira(pricing.renewalTerm.priceKobo), years: pricing.renewalTerm.years },
      ),
    }
  })
  const addable = rows.flatMap((row) => (row.ascii ? [row.ascii] : []))

  return (
    <div className="max-w-2xl space-y-6">
      <ul className="divide-y divide-border rounded-3xl border border-border bg-card">
        {rows.map((row) => (
          <li
            key={row.key}
            className="flex flex-col gap-1 px-5 py-4 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
          >
            <span className="break-all font-medium text-foreground">{row.shown}</span>
            <span className="text-sm text-muted-foreground">
              {row.words ?? 'Not a domain we sell'}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">
        Prices are in naira before VAT ({priced.vatPct}%), which checkout adds as its own line. Each
        name is checked again when you add it, in case someone else has registered it since.
      </p>
      {addable.length > 0 ? <CartLinkAdd domains={addable} /> : null}
    </div>
  )
}
