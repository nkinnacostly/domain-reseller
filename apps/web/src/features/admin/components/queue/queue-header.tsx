import { PanelHeader } from '@/components/layout/panel'
import { RouteTabs } from '@/features/admin/components/route-tabs'
import { SideSwitch } from '@/features/admin/components/shell/side-switch'
import type { AdminSide } from '@/features/admin/lib/side'

/** The queue's three lists, as pages: the URL says which is open (S13). */
export const QUEUE_TABS = [
  { href: '/admin/queue', label: 'Jobs', exact: true },
  { href: '/admin/queue/ssl-jobs', label: 'Certificate jobs', exact: true },
  { href: '/admin/queue/pending', label: 'Paid, no job', exact: true },
] as const

/** The queue pages' first card: where you are, the side, and the tabs. */
export function QueueHeader({
  side,
  testOnly,
  description = 'Registrations, renewals, transfers, settings changes and certificate jobs, as the worker leaves them. A job moves only through the queue functions: Retry and Fail call them, with your code.',
}: {
  side: AdminSide
  testOnly: boolean
  description?: string
}) {
  return (
    <PanelHeader
      crumbs={[{ label: 'Admin', href: '/admin' }, { label: 'Queue' }]}
      title="Queue"
      description={description}
      actions={<SideSwitch side={side} testOnly={testOnly} />}
    >
      <RouteTabs label="Queue lists" tabs={[...QUEUE_TABS]} />
    </PanelHeader>
  )
}
