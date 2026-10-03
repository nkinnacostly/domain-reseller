import { ChevronLeft, ChevronRight } from 'lucide-react'
import Link from 'next/link'
import { FOCUS } from '@/components/layout/panel'
import { formatCount } from '@/features/admin/lib/format'
import { cn } from '@/lib/utils'

const PAGE_LINK =
  'inline-flex h-11 items-center gap-1.5 rounded-full border border-border bg-background px-4 text-sm text-foreground transition-transform hover:bg-brand-subtle active:scale-[0.98]'

/** Previous and next, as links, with where you are in words. */
export function Pager({
  page,
  pageCount,
  total,
  href,
}: {
  page: number
  pageCount: number
  total: number
  href: (page: number) => string
}) {
  if (pageCount <= 1) {
    return <p className="text-sm text-muted-foreground">{formatCount(total)} in all</p>
  }
  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">
        Page {page} of {pageCount} · {formatCount(total)} in all
      </p>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link href={href(page - 1)} rel="prev" className={cn(PAGE_LINK, FOCUS)}>
            <ChevronLeft className="size-4" aria-hidden="true" />
            Previous
          </Link>
        ) : (
          <span aria-disabled="true" className={cn(PAGE_LINK, 'opacity-50')}>
            <ChevronLeft className="size-4" aria-hidden="true" />
            Previous
          </span>
        )}
        {page < pageCount ? (
          <Link href={href(page + 1)} rel="next" className={cn(PAGE_LINK, FOCUS)}>
            Next
            <ChevronRight className="size-4" aria-hidden="true" />
          </Link>
        ) : (
          <span aria-disabled="true" className={cn(PAGE_LINK, 'opacity-50')}>
            Next
            <ChevronRight className="size-4" aria-hidden="true" />
          </span>
        )}
      </div>
    </nav>
  )
}
