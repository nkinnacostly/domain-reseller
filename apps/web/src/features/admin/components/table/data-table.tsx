import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import Link from 'next/link'
import { FOCUS, PANEL } from '@/components/layout/panel'
import type { SortDir } from '@/features/admin/lib/list-params'
import { cn } from '@/lib/utils'

/**
 * Every admin list (ADMIN-SPEC §5.1): cards below `xl`, a table from `xl` in
 * its own scroll box (S5 — `relative`, so the sr-only caption cannot widen
 * the page). Headers carry `scope`, a sorted one `aria-sort`, and sorting is
 * a link: the URL says how the list is ordered. Figures are tabular.
 */

export type Column<Row, S extends string = string> = {
  key: string
  header: string
  cell: (row: Row) => React.ReactNode
  /** The sort this column links to, when it can be sorted. */
  sort?: S
  /** Right-aligned figures. */
  numeric?: boolean
  className?: string
}

export type Sorting<S extends string> = {
  sort: S
  dir: SortDir
  /** The link that sorts by a column (flipping it when it is current). */
  href: (sort: S) => string
}

export function DataTable<Row, S extends string = string>({
  caption,
  rows,
  columns,
  rowKey,
  sorting,
  empty,
  className,
}: {
  caption: string
  rows: Row[]
  columns: Column<Row, S>[]
  rowKey: (row: Row) => string
  sorting?: Sorting<S>
  /** Shown instead of the list when there are no rows. */
  empty: React.ReactNode
  className?: string
}) {
  if (rows.length === 0) return <>{empty}</>
  const [first, ...rest] = columns

  return (
    <div className={className}>
      <ul aria-label={caption} className="space-y-3 xl:hidden">
        {rows.map((row) => (
          <li key={rowKey(row)} className={cn(PANEL, 'p-4')}>
            {first ? (
              <div className="min-w-0 font-medium text-foreground">{first.cell(row)}</div>
            ) : null}
            <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
              {rest.map((column) => (
                <div key={column.key} className="flex min-w-0 justify-between gap-3 sm:block">
                  <dt className="text-muted-foreground">{column.header}</dt>
                  <dd
                    className={cn(
                      'min-w-0 text-right break-words text-foreground sm:text-left',
                      column.numeric && 'tabular-nums',
                    )}
                  >
                    {column.cell(row)}
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>

      <div className={cn(PANEL, 'relative hidden overflow-x-auto xl:block')}>
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-border border-b text-left">
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={
                    sorting && column.sort
                      ? sorting.sort === column.sort
                        ? sorting.dir === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                      : undefined
                  }
                  className={cn(
                    'px-4 py-3 font-medium whitespace-nowrap text-muted-foreground',
                    column.numeric && 'text-right',
                  )}
                >
                  {sorting && column.sort ? (
                    <SortLink column={column.sort} header={column.header} sorting={sorting} />
                  ) : (
                    column.header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={rowKey(row)} className="border-border border-b last:border-b-0">
                {columns.map((column, index) =>
                  index === 0 ? (
                    <th
                      key={column.key}
                      scope="row"
                      className={cn(
                        'px-4 py-3 text-left font-medium text-foreground',
                        column.className,
                      )}
                    >
                      {column.cell(row)}
                    </th>
                  ) : (
                    <td
                      key={column.key}
                      className={cn(
                        'px-4 py-3 align-top text-foreground',
                        column.numeric && 'text-right tabular-nums',
                        column.className,
                      )}
                    >
                      {column.cell(row)}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SortLink<S extends string>({
  column,
  header,
  sorting,
}: {
  column: S
  header: string
  sorting: Sorting<S>
}) {
  const current = sorting.sort === column
  const Icon = current ? (sorting.dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown
  return (
    <Link
      href={sorting.href(column)}
      className={cn(
        'inline-flex min-h-11 items-center gap-1.5 rounded hover:text-foreground',
        current && 'text-foreground',
        FOCUS,
      )}
    >
      {header} <Icon className="size-3.5" aria-hidden="true" />
      <span className="sr-only">
        {current
          ? `(sorted ${sorting.dir === 'asc' ? 'ascending' : 'descending'}; select to reverse)`
          : '(select to sort)'}
      </span>
    </Link>
  )
}
