import { PanelPage, PanelPageSkeleton, PanelSkeleton } from '@/components/layout/panel'
import { TableSkeleton } from '@/features/admin/components/table/table-skeleton'

/** The customers list loading: header, totals, search, then pulsing rows (S11). */
export function CustomersSkeleton() {
  return (
    <PanelPage>
      <PanelPageSkeleton height="h-64" />
      <PanelSkeleton height="h-36" />
      <TableSkeleton rows={8} />
    </PanelPage>
  )
}

/** One customer loading: header with its tabs, then the tab's cards. */
export function CustomerSkeleton() {
  return (
    <PanelPage>
      <PanelPageSkeleton height="h-56" />
      <TableSkeleton rows={4} />
    </PanelPage>
  )
}
