import { PanelPage, PanelPageSkeleton, PanelSkeleton } from '@/components/layout/panel'
import { TableSkeleton } from '@/features/admin/components/table/table-skeleton'

/** The certificates list loading: header, figures, filters, then pulsing rows (S11). */
export function SslListSkeleton() {
  return (
    <PanelPage>
      <PanelPageSkeleton height="h-32" />
      <PanelSkeleton height="h-48" />
      <TableSkeleton rows={8} />
    </PanelPage>
  )
}

/** One certificate loading: header, where it stands, then its parts. */
export function CertificateSkeleton() {
  return (
    <PanelPage>
      <PanelPageSkeleton height="h-72" />
      <PanelSkeleton height="h-48" />
      <TableSkeleton rows={3} />
    </PanelPage>
  )
}
