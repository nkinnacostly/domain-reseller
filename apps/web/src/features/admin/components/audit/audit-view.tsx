import { Info } from 'lucide-react'
import { Panel, PanelHeader, PanelPage, PanelPageSkeleton } from '@/components/layout/panel'
import { ErrorState } from '@/features/admin/components/error-state'
import { TableSkeleton } from '@/features/admin/components/table/table-skeleton'
import {
  AUDIT_DESCRIPTION,
  AUDIT_READ_FAILED,
  AUDIT_SIDES_NOTE,
  AUDIT_TEST_ADMIN_NOTE,
  AUDIT_TITLE,
} from '@/features/admin/lib/audit-copy'
import { parseAuditParams } from '@/features/admin/lib/audit-params'
import { listAuditEntries } from '@/features/admin/queries/audit'
import { getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import { AuditFilters } from './audit-filters'
import { AuditList } from './audit-list'

/**
 * /admin/audit (docs/ADMIN-SPEC.md §5.2, B14): every admin action, refusal,
 * lookup and live read, newest first, filtered by the URL. Read-only for
 * everyone: the log is append-only, so the page has no edit, delete or
 * redact control. Each step is awaited inside the route's Suspense — the
 * admin asked of SQL first, then the side, then the URL, then the read.
 */

type Search = Record<string, string | string[] | undefined>

export async function AuditView({ searchParams }: { searchParams: Promise<Search> }) {
  const [admin, search] = await Promise.all([requireAdmin(), searchParams])
  const side = await getAdminSide(admin)
  const params = parseAuditParams(search, admin.testOnly)
  const page = await listAuditEntries(admin, side, params).then(
    (value) => ({ ok: true as const, value }),
    () => ({ ok: false as const }),
  )

  return (
    <PanelPage>
      <PanelHeader
        crumbs={[{ label: 'Admin', href: '/admin' }, { label: AUDIT_TITLE }]}
        title={AUDIT_TITLE}
        description={AUDIT_DESCRIPTION}
      >
        <p
          data-testid="audit-scope-note"
          className="flex items-start gap-2 text-sm text-muted-foreground"
        >
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {admin.testOnly ? AUDIT_TEST_ADMIN_NOTE : AUDIT_SIDES_NOTE}
        </p>
      </PanelHeader>
      {page.ok ? (
        <Panel labelledBy="audit-entries-heading" className="space-y-4">
          <h2 id="audit-entries-heading" className="font-medium text-foreground">
            Entries
          </h2>
          <AuditFilters params={params} testOnly={admin.testOnly} />
          <AuditList
            rows={page.value.rows}
            total={page.value.total}
            params={params}
            testOnly={admin.testOnly}
          />
        </Panel>
      ) : (
        <ErrorState title={AUDIT_READ_FAILED} />
      )}
    </PanelPage>
  )
}

/** The page loading: its header, the filters, then pulsing rows (S11). */
export function AuditSkeleton() {
  return (
    <PanelPage>
      <PanelPageSkeleton height="h-40" />
      <TableSkeleton rows={8} />
    </PanelPage>
  )
}
