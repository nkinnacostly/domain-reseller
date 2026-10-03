import { formatWatDate, formatWatTime } from '@/features/admin/lib/format'

/**
 * A time in a table cell: the day, then the time in WAT, each kept whole, so
 * a narrow column breaks between them rather than inside "3 Oct 2026".
 */
export function When({ at }: { at: string | null | undefined }) {
  if (!at) return <>—</>
  return (
    <time dateTime={at}>
      <span className="whitespace-nowrap">{formatWatDate(at)}</span>{' '}
      <span className="whitespace-nowrap text-muted-foreground">{formatWatTime(at)}</span>
    </time>
  )
}
