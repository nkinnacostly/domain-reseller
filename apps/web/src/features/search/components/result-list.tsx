import { AddToCartButton } from '@/features/cart/components/add-to-cart-button'
import { renewalText, yearsText } from '@/features/pricing/lib/terms'
import { refusalNote, type SearchRow } from '../lib/rows'
import { AsciiForm, LookalikeWarning } from './idn-notes'
import { ResultStatus } from './result-status'

/**
 * A compact list of results — the other extensions for the same name, or the
 * suggestions. Every available row carries its renewal price (N8).
 */
export function ResultList({ rows, label }: { rows: SearchRow[]; label: string }) {
  return (
    <ul
      aria-label={label}
      className="divide-y divide-border/70 rounded-2xl border border-border bg-background"
    >
      {rows.map((row) => (
        <ResultItem key={row.domain} row={row} />
      ))}
    </ul>
  )
}

/**
 * One result row. The domain is the row's first `span`: e2e reads it there.
 * An international name shows its ASCII form beneath (FR-S8), and a refusal
 * says why when there is a reason to give (FR-S8, FR-S9).
 */
export function ResultItem({
  row,
  lookalike = false,
}: {
  row: SearchRow
  /** Say when the name can pass for a Latin one (FR-S8) — where each row is its own name. */
  lookalike?: boolean
}) {
  const refusal = refusalNote(row)
  return (
    <li
      data-status={row.status}
      className="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-4 sm:px-5"
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={
              row.status === 'available'
                ? 'min-w-0 truncate font-semibold text-foreground'
                : 'min-w-0 truncate font-medium text-muted-foreground'
            }
          >
            {row.display}
          </span>
          <ResultStatus status={row.status} />
        </div>
        <AsciiForm domain={row.domain} display={row.display} className="mt-0.5 block" />
        {refusal ? (
          <p className="mt-1 text-pretty text-xs text-muted-foreground">{refusal}</p>
        ) : null}
        {lookalike ? <LookalikeWarning stem={row.name} compact className="mt-1.5" /> : null}
      </div>

      {row.status === 'available' && row.price ? (
        <div className="flex flex-wrap items-center justify-between gap-3 sm:justify-end">
          <p className="flex flex-wrap items-baseline gap-x-2 text-sm sm:text-right">
            <span className="text-base font-semibold text-foreground tabular-nums">
              {row.price.register}
            </span>
            {row.price.registerYears > 1 ? (
              <span className="text-muted-foreground">
                for {yearsText(row.price.registerYears)}
              </span>
            ) : null}
            <span className="text-muted-foreground">
              then{' '}
              <span
                className={row.price.renewalIsHigher ? 'font-medium text-foreground' : undefined}
              >
                {renewalText(row.price.renew, row.price.renewYears)}
              </span>
            </span>
          </p>
          <AddToCartButton domain={row.domain} label={row.display} />
        </div>
      ) : null}
    </li>
  )
}
