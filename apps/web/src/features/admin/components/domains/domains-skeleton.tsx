import { PanelPage, PanelPageSkeleton, PanelSkeleton } from '@/components/layout/panel'
import { TableSkeleton } from '@/features/admin/components/table/table-skeleton'

/** The domains list loading: header, figures, filters, then pulsing rows (S11). */
export function DomainsSkeleton() {
  return (
    <PanelPage>
      <PanelPageSkeleton height="h-72" />
      <PanelSkeleton height="h-56" />
      <TableSkeleton rows={8} />
    </PanelPage>
  )
}

/** One domain loading: header, summary, then its parts. */
export function DomainSkeleton() {
  return (
    <PanelPage>
      <PanelPageSkeleton height="h-72" />
      <PanelSkeleton height="h-48" />
      <TableSkeleton rows={3} />
    </PanelPage>
  )
}
