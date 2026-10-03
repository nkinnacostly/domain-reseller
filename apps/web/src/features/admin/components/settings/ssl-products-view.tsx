import { Suspense } from 'react'
import { PANEL_HEADING, PanelPage } from '@/components/layout/panel'
import { AdminStatusPill } from '@/features/admin/components/admin-status-pill'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { TableSkeleton } from '@/features/admin/components/table/table-skeleton'
import { canAct } from '@/features/admin/lib/actions'
import { formatCount, formatWatDate } from '@/features/admin/lib/format'
import { OWNER_ONLY, SETTINGS_PAGES } from '@/features/admin/lib/settings-copy'
import type { AdminSide } from '@/features/admin/lib/side'
import { type AdminPrincipal, getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import { listSslProducts, type SslProductRow } from '@/features/admin/queries/settings'
import { RoleNote, SettingsHeader } from './settings-header'
import { SslProductAction } from './ssl-product-action'

/**
 * `/admin/settings/ssl-products` (docs/ADMIN-SPEC.md §5.2 B13): every
 * certificate product the weekly sync lists, and the one column it never
 * writes — whether it is on sale, which is the owner's (CLAUDE.md §15).
 */
export async function SslProductsView() {
  const admin = await requireAdmin()
  const side = await getAdminSide(admin)
  return (
    <PanelPage>
      <SettingsHeader
        title={SETTINGS_PAGES.ssl.title}
        description={SETTINGS_PAGES.ssl.description}
        side={side}
        testOnly={admin.testOnly}
      />
      <Suspense fallback={<TableSkeleton rows={6} />}>
        <SslProductList admin={admin} side={side} />
      </Suspense>
    </PanelPage>
  )
}

function kindWords(row: SslProductRow): string {
  const parts = [row.validationType ? row.validationType.toUpperCase() : null]
  if (row.isWildcard) parts.push('wildcard')
  if (row.isMultiDomain) {
    parts.push(row.maxNames ? `up to ${formatCount(row.maxNames)} names` : 'several names')
  }
  return parts.filter(Boolean).join(' · ') || '—'
}

export async function SslProductList({ admin, side }: { admin: AdminPrincipal; side: AdminSide }) {
  const products = await listSslProducts(admin, side)
  if (!products) return <ErrorState title="The SSL products couldn't be loaded." />
  const onSale = products.filter((row) => row.isSellable).length
  const columns: Column<SslProductRow>[] = [
    {
      key: 'name',
      header: 'Product',
      cell: (row) => (
        <span>
          {row.name ?? row.productCode}
          <span className="block text-xs font-normal text-muted-foreground">
            {row.vendor ? `${row.vendor} · ` : ''}code {row.productCode}
          </span>
        </span>
      ),
    },
    { key: 'kind', header: 'Kind', cell: kindWords },
    {
      key: 'sale',
      header: 'On sale',
      cell: (row) => (
        <AdminStatusPill
          value={row.isSellable ? 'on_sale' : 'off_sale'}
          tone={row.isSellable ? 'ok' : 'neutral'}
          labels={{ on_sale: 'On sale', off_sale: 'Off sale' }}
        />
      ),
    },
    {
      key: 'price',
      header: 'Price listed',
      cell: (row) => (row.hasPrice ? 'Yes' : 'No'),
    },
    {
      key: 'synced',
      header: 'Synced',
      cell: (row) => <span className="whitespace-nowrap">{formatWatDate(row.syncedAt)}</span>,
    },
    {
      key: 'action',
      header: 'Change',
      cell: (row) => (
        <SslProductAction
          productCode={row.productCode}
          name={row.name ?? row.productCode}
          isSellable={row.isSellable}
          hasPrice={row.hasPrice}
        />
      ),
    },
  ]
  return (
    <section aria-labelledby="settings-ssl-heading" className="space-y-3">
      <div className="space-y-2 px-1">
        <h2 id="settings-ssl-heading" className={PANEL_HEADING}>
          Products · {formatCount(products.length)}, {formatCount(onSale)} on sale
        </h2>
        <RoleNote words={canAct(admin, 'ssl_product.sellable') ? null : OWNER_ONLY.ssl} />
      </div>
      <DataTable
        caption="SSL products"
        rows={products}
        columns={columns}
        rowKey={(row) => row.productCode}
        empty={
          <EmptyState
            title="No SSL products yet."
            body="The gateway syncs DomainNameAPI's list every week; the products appear after its first run."
          />
        }
      />
    </section>
  )
}
