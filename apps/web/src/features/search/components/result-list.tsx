import type { SearchRow } from '../lib/rows'
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
        <li
          key={row.domain}
          data-status={row.status}
          className="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-4 sm:px-5"
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span
              className={
                row.status === 'available'
                  ? 'min-w-0 truncate font-semibold text-foreground'
                  : 'min-w-0 truncate font-medium text-muted-foreground'
              }
            >
              {row.domain}
            </span>
            <ResultStatus status={row.status} />
          </div>

          {row.status === 'available' && row.price ? (
            <p className="flex flex-wrap items-baseline gap-x-2 text-sm sm:justify-end sm:text-right">
              <span className="text-base font-semibold text-foreground tabular-nums">
                {row.price.register}
              </span>
              <span className="text-muted-foreground">
                then{' '}
                <span
                  className={row.price.renewalIsHigher ? 'font-medium text-foreground' : undefined}
                >
                  {row.price.renew}/yr
                </span>
              </span>
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
