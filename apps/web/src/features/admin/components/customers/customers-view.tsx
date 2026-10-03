import { PANEL_HEADING, Panel, PanelHeader, PanelPage } from '@/components/layout/panel'
import { SideSwitch } from '@/features/admin/components/shell/side-switch'
import { canAct } from '@/features/admin/lib/actions'
import {
  CUSTOMERS_DESCRIPTION,
  LIST_HEADING,
  SEARCH_HEADING,
} from '@/features/admin/lib/customers-copy'
import { parseCustomerListParams } from '@/features/admin/lib/customers-params'
import { formatCount } from '@/features/admin/lib/format'
import {
  type CustomerList,
  getCustomerStats,
  listCustomers,
} from '@/features/admin/queries/customers'
import { getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import { CustomerSearch } from './customer-search'
import { CustomerStatsPanel } from './customer-stats'
import { CustomerFilters, CustomersList } from './customers-list'

type Search = Record<string, string | string[] | undefined>

/** `/admin/customers` (B8): the totals, the POST search, then every account, masked. */
export async function CustomersView({ searchParams }: { searchParams: Promise<Search> }) {
  const admin = await requireAdmin()
  const side = await getAdminSide(admin)
  const params = parseCustomerListParams(await searchParams)
  const [stats, list] = await Promise.all([
    getCustomerStats(admin),
    listCustomers(admin, side, params).catch((): CustomerList | null => null),
  ])

  return (
    <PanelPage>
      <PanelHeader
        crumbs={[{ label: 'Admin', href: '/admin' }, { label: 'Customers' }]}
        title="Customers"
        description={CUSTOMERS_DESCRIPTION}
        actions={<SideSwitch side={side} testOnly={admin.testOnly} />}
      />
      <CustomerStatsPanel result={stats} />
      <Panel labelledBy="customer-search-heading" className="space-y-4">
        <h2 id="customer-search-heading" className={PANEL_HEADING}>
          {SEARCH_HEADING}
        </h2>
        <CustomerSearch testOnly={admin.testOnly} canSearch={canAct(admin, 'customer.search')} />
      </Panel>
      <section aria-labelledby="customers-list-heading" className="space-y-3">
        <h2 id="customers-list-heading" className="px-1 font-medium text-foreground">
          {list && list.rows.length > 0
            ? `${LIST_HEADING} · ${formatCount(list.total)}`
            : LIST_HEADING}
        </h2>
        <CustomerFilters params={params} />
        <CustomersList side={side} testOnly={admin.testOnly} params={params} list={list} />
      </section>
    </PanelPage>
  )
}
