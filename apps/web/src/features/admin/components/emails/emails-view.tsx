import { Suspense } from 'react'
import { PanelHeader, PanelPage, PanelPageSkeleton } from '@/components/layout/panel'
import { SideSwitch } from '@/features/admin/components/shell/side-switch'
import { TableSkeleton } from '@/features/admin/components/table/table-skeleton'
import { EMAILS_DESCRIPTION, EMAILS_TITLE } from '@/features/admin/lib/emails-copy'
import { parseEmailsParams } from '@/features/admin/lib/emails-params'
import { getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import { ComplianceTab } from './compliance-tab'
import { EmailTabs } from './email-parts'
import { OutboxTab } from './outbox-tab'

/**
 * /admin/emails (docs/ADMIN-SPEC.md §5.2, B11): the outbox — what the
 * database queued and what became of each email — and the ERRP notices
 * kept as compliance records, on the side the admin is looking at. The only
 * action is "Send again" on a failed email; the compliance tab has none.
 */

type Search = Record<string, string | string[] | undefined>

export async function EmailsView({ searchParams }: { searchParams: Promise<Search> }) {
  const [admin, search] = await Promise.all([requireAdmin(), searchParams])
  const side = await getAdminSide(admin)
  const params = parseEmailsParams(search)
  const now = new Date()

  return (
    <PanelPage>
      <PanelHeader
        crumbs={[{ label: 'Admin', href: '/admin' }, { label: EMAILS_TITLE }]}
        title={EMAILS_TITLE}
        description={EMAILS_DESCRIPTION}
        actions={<SideSwitch side={side} testOnly={admin.testOnly} />}
      >
        <EmailTabs current={params.tab} />
      </PanelHeader>
      <Suspense key={params.tab} fallback={<TableSkeleton rows={8} />}>
        {params.tab === 'compliance' ? (
          <ComplianceTab admin={admin} side={side} params={params} />
        ) : (
          <OutboxTab admin={admin} side={side} params={params} now={now} />
        )}
      </Suspense>
    </PanelPage>
  )
}

/** The page loading: its header, then a list, pulsing (S11). */
export function EmailsSkeleton() {
  return (
    <PanelPage>
      <PanelPageSkeleton height="h-40" />
      <TableSkeleton rows={8} />
    </PanelPage>
  )
}
