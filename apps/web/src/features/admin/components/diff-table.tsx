import { cn } from '@/lib/utils'

export type DiffRow = {
  label: string
  ours: React.ReactNode
  theirs: React.ReactNode
  differs: boolean
}

/**
 * Our record beside another's (the registry's), field by field. A row that
 * differs says "Differs" in words as well as being marked (S8).
 */
export function DiffTable({
  caption,
  rows,
  oursLabel = 'Ours',
  theirsLabel = 'Registry',
}: {
  caption: string
  rows: DiffRow[]
  oursLabel?: string
  theirsLabel?: string
}) {
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-border border-b text-left text-muted-foreground">
            <th scope="col" className="py-2 pr-4 font-medium">
              Field
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              {oursLabel}
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              {theirsLabel}
            </th>
            <th scope="col" className="py-2 font-medium">
              <span className="sr-only">Match</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.label}
              className={cn(
                'border-border border-b last:border-b-0',
                row.differs && 'bg-status-expiring/10',
              )}
            >
              <th scope="row" className="py-2 pr-4 text-left font-medium text-foreground">
                {row.label}
              </th>
              <td className="py-2 pr-4 break-words text-foreground">{row.ours ?? '—'}</td>
              <td className="py-2 pr-4 break-words text-foreground">{row.theirs ?? '—'}</td>
              <td className="py-2 text-xs whitespace-nowrap">
                {row.differs ? (
                  <span className="font-medium text-foreground">Differs</span>
                ) : (
                  <span className="text-muted-foreground">Same</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
