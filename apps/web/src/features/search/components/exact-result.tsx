import { ArrowUpRight } from 'lucide-react'
import Link from 'next/link'
import { transferCheckHref } from '@/features/transfers/lib/href'
import type { SearchRow } from '../lib/rows'
import { ResultStatus } from './result-status'

/**
 * The exact match — the one domain the person asked for, in large type
 * (PRD §15.3). The renewal price sits at 80% of the first-year size, the
 * floor FR-S2 sets, so the second year is never the small print.
 */
export function ExactResult({ row }: { row: SearchRow }) {
  return (
    <article
      aria-labelledby="exact-domain"
      data-status={row.status}
      className="rounded-3xl border border-border bg-background p-6 shadow-[0_18px_40px_-24px_rgb(0_0_0/0.25)] sm:p-8"
    >
      <div className="flex flex-wrap items-center gap-3">
        <ResultStatus status={row.status} />
        <p className="text-sm text-muted-foreground">Exact match</p>
      </div>

      <h2
        id="exact-domain"
        className="mt-4 text-3xl font-bold tracking-tight break-all text-foreground sm:text-4xl"
      >
        {row.domain}
      </h2>

      {row.status === 'available' && row.price ? (
        <div className="mt-6">
          <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span
              data-price="first-year"
              className="text-3xl font-bold tracking-tight text-foreground tabular-nums"
            >
              {row.price.register}
            </span>
            <span className="text-sm text-muted-foreground">first year</span>
          </p>
          <p className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span
              data-price="renewal"
              className={
                row.price.renewalIsHigher
                  ? 'text-2xl font-semibold tracking-tight text-foreground tabular-nums'
                  : 'text-2xl font-semibold tracking-tight text-muted-foreground tabular-nums'
              }
            >
              {row.price.renew}/yr
            </span>
            <span className="text-sm text-muted-foreground">
              {row.price.renewalIsHigher
                ? 'every year after — higher than the first'
                : 'every year after'}
            </span>
          </p>
          <p className="mt-4 text-xs text-muted-foreground">
            In naira, before VAT
            {row.price.includesIcannFee ? ' · includes the ICANN fee' : ''} · register for up to{' '}
            {row.price.maxPeriod} years
          </p>
        </div>
      ) : null}

      {row.status === 'available' && !row.price ? (
        <p className="mt-4 text-muted-foreground">
          It is available, but we cannot show a price for it right now.
        </p>
      ) : null}

      {row.status === 'registered' ? (
        <div className="mt-4 space-y-4">
          <p className="text-pretty text-muted-foreground">
            Someone already holds {row.domain}. The alternatives below are free right now.
          </p>
          <Link
            href={transferCheckHref(row.domain)}
            className="inline-flex items-center gap-1 text-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Is it yours? Check whether it can transfer
            <ArrowUpRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
      ) : null}

      {row.status === 'premium' ? (
        <p className="mt-4 text-pretty text-muted-foreground">
          The registry sells this name at its own premium price, which we cannot offer yet. The
          alternatives below are sold at our normal prices.
        </p>
      ) : null}

      {row.status === 'restricted' ? (
        <p className="mt-4 text-pretty text-muted-foreground">
          This name cannot be registered. The registry reserves it, or it breaks the rules for{' '}
          {`.${row.tld}`} — most often the minimum length.
        </p>
      ) : null}

      {row.status === 'unknown' ? (
        <p className="mt-4 text-pretty text-muted-foreground">
          The .{row.tld} registry did not answer in time. Search again in a moment.
        </p>
      ) : null}
    </article>
  )
}
