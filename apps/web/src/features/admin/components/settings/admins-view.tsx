import { Suspense } from 'react'
import { PANEL_HEADING, PanelPage } from '@/components/layout/panel'
import { AdminStatusPill, TestBadge } from '@/features/admin/components/admin-status-pill'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { TableSkeleton } from '@/features/admin/components/table/table-skeleton'
import { formatWat, formatWatDate } from '@/features/admin/lib/format'
import {
  ADMINS_NOTE,
  ADMINS_TEST_NOTE,
  pinnedWords,
  ROLE_WORDS,
  SETTINGS_PAGES,
} from '@/features/admin/lib/settings-copy'
import { pinnedTone } from '@/features/admin/lib/settings-presets'
import { type AdminPrincipal, getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import { type AdminRow, listAdmins } from '@/features/admin/queries/settings'
import { SettingsHeader } from './settings-header'

/**
 * `/admin/settings/admins` (docs/ADMIN-SPEC.md §5.2 B13, D16): who can open
 * the admin area — labels, roles, linked devices — from `admin_list_admins`,
 * which carries no id or email and answers a test admin its own row only.
 * The page lists; it never enrols. Admins are changed in the SQL editor.
 */
export async function AdminsView() {
  const admin = await requireAdmin()
  const side = await getAdminSide(admin)
  return (
    <PanelPage>
      <SettingsHeader
        title={SETTINGS_PAGES.admins.title}
        description={SETTINGS_PAGES.admins.description}
        side={side}
        testOnly={admin.testOnly}
      />
      <Suspense fallback={<TableSkeleton rows={3} />}>
        <AdminList admin={admin} />
      </Suspense>
    </PanelPage>
  )
}

export async function AdminList({ admin }: { admin: AdminPrincipal }) {
  const admins = await listAdmins()
  if (!admins) return <ErrorState title="The admins couldn't be loaded." />
  const columns: Column<AdminRow>[] = [
    {
      key: 'label',
      header: 'Label',
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-2">
          <span className="font-mono">{row.label}</span>
          {row.label === admin.label ? (
            <span className="text-xs font-normal text-muted-foreground">(you)</span>
          ) : null}
        </span>
      ),
    },
    { key: 'role', header: 'Role', cell: (row) => ROLE_WORDS[row.role] ?? row.role },
    {
      key: 'test',
      header: 'Test only',
      cell: (row) => (row.testOnly ? <TestBadge /> : 'No'),
    },
    {
      key: 'added',
      header: 'Added',
      cell: (row) => formatWatDate(row.addedAt),
    },
    {
      key: 'revoked',
      header: 'Revoked',
      cell: (row) => (row.revokedAt ? formatWatDate(row.revokedAt) : 'No'),
    },
    {
      key: 'devices',
      header: 'Pinned devices',
      cell: (row) => (
        <span data-devices={row.label}>
          <AdminStatusPill
            value="devices"
            tone={pinnedTone(row.pinnedFactors, row.verifiedPinnedFactors)}
            labels={{ devices: pinnedWords(row.pinnedFactors, row.verifiedPinnedFactors) }}
          />
        </span>
      ),
    },
    {
      key: 'change',
      header: 'Last change',
      cell: (row) => formatWat(row.lastChangeAt),
    },
  ]
  return (
    <section aria-labelledby="settings-admins-heading" className="space-y-3">
      <div className="space-y-2 px-1">
        <h2 id="settings-admins-heading" className={PANEL_HEADING}>
          Admins · {admins.length}
        </h2>
        <p className="max-w-2xl rounded-xl bg-muted/60 px-3.5 py-3 text-sm text-foreground">
          {ADMINS_NOTE}
          {admin.testOnly ? ` ${ADMINS_TEST_NOTE}` : ''}
        </p>
      </div>
      <DataTable
        caption="Admins"
        rows={admins}
        columns={columns}
        rowKey={(row) => row.label}
        empty={<EmptyState title="No admins are listed." body={ADMINS_NOTE} />}
      />
    </section>
  )
}
