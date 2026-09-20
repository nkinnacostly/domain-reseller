'use client'

import { ArrowUpRight, Search } from 'lucide-react'
import Link from 'next/link'
import { useDeferredValue, useId, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { PublicPriceRow } from '../lib/public-row'

const PAGE_SIZE = 40

export function PricingTable({ rows }: { rows: PublicPriceRow[] }) {
  const inputId = useId()
  const [query, setQuery] = useState('')
  const [visible, setVisible] = useState(PAGE_SIZE)

  // Keeps typing responsive while filtering 700 rows.
  const deferredQuery = useDeferredValue(query)

  const filtered = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase().replace(/^\./, '')
    if (!needle) return rows
    return rows.filter((row) => row.tld.includes(needle))
  }, [rows, deferredQuery])

  const shown = filtered.slice(0, visible)

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="w-full sm:max-w-xs">
          <label htmlFor={inputId} className="block text-sm font-medium text-foreground">
            Find an extension
          </label>
          <div className="relative mt-2">
            <Search
              className="-translate-y-1/2 absolute top-1/2 left-3 size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              id={inputId}
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setVisible(PAGE_SIZE)
              }}
              placeholder="ng, com, africa…"
              className="h-11 w-full rounded-full border border-border bg-background pr-4 pl-9 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </div>
        </div>

        <p aria-live="polite" className="text-sm text-muted-foreground">
          {filtered.length === rows.length
            ? `${rows.length} extensions`
            : `${filtered.length} of ${rows.length} extensions`}
        </p>
      </div>

      {/* Tables get their own scroll container so the page never scrolls sideways. */}
      <div className="mt-6 overflow-x-auto">
        <table className="w-full min-w-[42rem] border-collapse text-sm">
          <caption className="sr-only">
            Domain prices by extension, showing first-year, renewal and transfer prices in naira
            excluding VAT
          </caption>
          <thead>
            <tr className="border-border border-b text-left">
              <th scope="col" className="py-3 pr-4 font-semibold">
                Extension
              </th>
              <th scope="col" className="py-3 pr-4 text-right font-semibold">
                First year
              </th>
              <th scope="col" className="py-3 pr-4 text-right font-semibold">
                Renewal
              </th>
              <th scope="col" className="py-3 pr-4 text-right font-semibold">
                Transfer
              </th>
              <th scope="col" className="py-3 text-right font-semibold">
                <span className="sr-only">Register</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.tld} className="border-border/60 border-b">
                <th scope="row" className="py-3 pr-4 text-left font-medium">
                  {`.${row.tld}`}
                  {row.isCountryCode ? null : (
                    <span className="ml-2 text-muted-foreground text-xs">+ ICANN fee</span>
                  )}
                  {row.requiresExtraFields ? (
                    <span className="mt-0.5 block text-muted-foreground text-xs font-normal">
                      Eligibility rules apply
                    </span>
                  ) : null}
                </th>
                <td className="py-3 pr-4 text-right tabular-nums">{row.register}</td>
                <td className="py-3 pr-4 text-right tabular-nums">
                  <span className={row.renewalIsHigher ? 'font-semibold text-foreground' : ''}>
                    {row.renew}
                  </span>
                  {row.renewalIsHigher ? (
                    <span className="sr-only"> — higher than the first year</span>
                  ) : null}
                </td>
                <td className="py-3 pr-4 text-right tabular-nums text-muted-foreground">
                  {row.transfer ?? '—'}
                </td>
                <td className="py-3 text-right">
                  <Link
                    href={`/search?q=yourbrand.${row.tld}`}
                    className="inline-flex items-center gap-1 text-accent text-sm hover:underline"
                  >
                    Search
                    <ArrowUpRight className="size-3.5" aria-hidden="true" />
                    <span className="sr-only">for a .{row.tld} domain</span>
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 ? (
        <p className="py-10 text-center text-muted-foreground text-sm">
          No extension matches “{query.trim()}”. Try a shorter search.
        </p>
      ) : null}

      {visible < filtered.length ? (
        <div className="mt-8 text-center">
          <Button
            variant="secondary"
            className="rounded-full"
            onClick={() => setVisible((v) => v + PAGE_SIZE)}
          >
            Show more extensions
          </Button>
          <p className="mt-2 text-muted-foreground text-xs">
            Showing {shown.length} of {filtered.length}
          </p>
        </div>
      ) : null}
    </div>
  )
}
