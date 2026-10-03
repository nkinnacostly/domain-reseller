import { PanelPage, PanelPageSkeleton } from '@/components/layout/panel'

/** An admin page's loading state: its header and one card, pulsing (S11). */
export function AdminPageSkeleton() {
  return (
    <PanelPage>
      <PanelPageSkeleton />
    </PanelPage>
  )
}
