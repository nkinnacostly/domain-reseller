import { PanelPage, PanelPageSkeleton, PanelSkeleton } from '@/components/layout/panel'
import { TableSkeleton } from '@/features/admin/components/table/table-skeleton'

/** The orders list loading: header, funnel, filters, then pulsing rows (S11). */
export function OrdersSkeleton() {
  return (
    <PanelPage>
      <PanelPageSkeleton height="h-40" />
      <PanelSkeleton height="h-56" />
      <TableSkeleton rows={8} />
    </PanelPage>
  )
}

/** One order loading: header, summary, then its parts. */
export function OrderSkeleton() {
  return (
    <PanelPage>
      <PanelPageSkeleton height="h-72" />
      <TableSkeleton rows={3} />
      <TableSkeleton rows={2} />
    </PanelPage>
  )
}
