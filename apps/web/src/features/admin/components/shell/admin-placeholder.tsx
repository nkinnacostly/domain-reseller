import { Construction } from 'lucide-react'
import { Panel, PanelHeader, PanelPage } from '@/components/layout/panel'
import { getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import { SideSwitch } from './side-switch'

/**
 * A page whose package has not landed yet (ADMIN-SPEC §9). It still asks
 * SQL who is looking, shows the side, and says where the work is done until
 * then — the SQL editor stays the fallback (D20).
 */
export async function AdminPlaceholder({
  title,
  description,
  parent,
}: {
  title: string
  description?: string
  /** The page above this one, for the breadcrumb. */
  parent?: { label: string; href: string }
}) {
  const admin = await requireAdmin()
  const side = await getAdminSide(admin)
  const crumbs = [{ label: 'Admin', href: '/admin' }, ...(parent ? [parent] : []), { label: title }]

  return (
    <PanelPage>
      <PanelHeader
        crumbs={crumbs}
        title={title}
        description={description}
        actions={<SideSwitch side={side} testOnly={admin.testOnly} />}
      />
      <Panel labelledBy="admin-placeholder-heading">
        <div className="flex items-start gap-3">
          <Construction
            className="mt-0.5 size-5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="space-y-2">
            <h2 id="admin-placeholder-heading" className="font-medium text-foreground">
              This page is on its way
            </h2>
            <p className="max-w-xl text-sm/6 text-muted-foreground">
              Until it lands, do this from the SQL editor as docs/DEPLOY.md §6 describes. Nothing
              here reads or changes anything yet.
            </p>
          </div>
        </div>
      </Panel>
    </PanelPage>
  )
}
