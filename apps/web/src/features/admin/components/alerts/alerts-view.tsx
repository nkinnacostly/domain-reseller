import { connection } from 'next/server'
import { Suspense } from 'react'
import { PanelHeader, PanelPage, PanelPageSkeleton } from '@/components/layout/panel'
import { SideSwitch } from '@/features/admin/components/shell/side-switch'
import { TableSkeleton } from '@/features/admin/components/table/table-skeleton'
import { ALERTS_DESCRIPTION, ALERTS_TITLE, TEST_SIDE_NOTE } from '@/features/admin/lib/alerts-copy'
import { type AlertsParams, parseAlertsParams } from '@/features/admin/lib/alerts-params'
import type { AdminSide } from '@/features/admin/lib/side'
import { type AdminPrincipal, getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import { AlertHistory, OpenAlerts } from './alert-lists'
import { AlertsNote, AlertTabs } from './alert-parts'
import { DriftList } from './drift-list'
import { HealthTab } from './health'

/**
 * /admin/alerts (docs/ADMIN-SPEC.md §5.2, B5): open alerts, their history,
 * registry drift and the background services' health, on the side the
 * admin is looking at. Nothing here acts — there is no dismiss, no resolve
 * and no retry; each row links to the page where its cause is worked.
 */

type Search = Record<string, string | string[] | undefined>

export async function AlertsView({ searchParams }: { searchParams: Promise<Search> }) {
  await connection()
  const [admin, search] = await Promise.all([requireAdmin(), searchParams])
  const side = await getAdminSide(admin)
  const params = parseAlertsParams(search)
  const now = new Date()

  return (
    <PanelPage>
      <PanelHeader
        crumbs={[{ label: 'Admin', href: '/admin' }, { label: ALERTS_TITLE }]}
        title={ALERTS_TITLE}
        description={ALERTS_DESCRIPTION}
        actions={<SideSwitch side={side} testOnly={admin.testOnly} />}
      >
        <AlertTabs current={params.tab} />
      </PanelHeader>
      {side === 'test' && (params.tab === 'open' || params.tab === 'history') ? (
        <AlertsNote testId="alerts-test-side-note">{TEST_SIDE_NOTE}</AlertsNote>
      ) : null}
      <Suspense key={params.tab} fallback={<TableSkeleton />}>
        <AlertsTab admin={admin} side={side} params={params} now={now} />
      </Suspense>
    </PanelPage>
  )
}

/** The chosen tab's content. */
export function AlertsTab({
  admin,
  side,
  params,
  now,
}: {
  admin: AdminPrincipal
  side: AdminSide
  params: AlertsParams
  now: Date
}) {
  switch (params.tab) {
    case 'open':
      return <OpenAlerts admin={admin} side={side} params={params} now={now} />
    case 'history':
      return <AlertHistory admin={admin} side={side} params={params} now={now} />
    case 'drift':
      return <DriftList admin={admin} side={side} params={params} now={now} />
    case 'health':
      return <HealthTab admin={admin} side={side} now={now} />
  }
}

/** The page's loading state: its header and a list, pulsing (S11). */
export function AlertsSkeleton() {
  return (
    <PanelPage>
      <PanelPageSkeleton height="h-80" />
    </PanelPage>
  )
}
