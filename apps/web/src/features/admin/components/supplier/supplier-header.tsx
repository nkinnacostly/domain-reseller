import { PANEL, PanelHeader, PanelPage } from '@/components/layout/panel'
import { RouteTabs } from '@/features/admin/components/route-tabs'
import { SideSwitch } from '@/features/admin/components/shell/side-switch'
import type { AdminSide } from '@/features/admin/lib/side'
import { cn } from '@/lib/utils'

/**
 * The Supplier pages' shared header (docs/ADMIN-SPEC.md §5.2 B6): where you
 * are, the Live/Test switch, and the five pages as tabs — the current one
 * marked with `aria-current` (S13).
 */

export const SUPPLIER_TABS = [
  { href: '/admin/supplier', label: 'Balance', exact: true },
  { href: '/admin/supplier/ledger', label: 'Ledger' },
  { href: '/admin/supplier/calls', label: 'Calls' },
  { href: '/admin/supplier/lookup', label: 'Lookup' },
  { href: '/admin/supplier/catalogue', label: 'Price list' },
] as const

export function SupplierHeader({
  title,
  description,
  side,
  testOnly,
}: {
  title: string
  description: string
  side: AdminSide
  testOnly: boolean
}) {
  const index = title === 'Supplier'
  return (
    <PanelHeader
      crumbs={[
        { label: 'Admin', href: '/admin' },
        ...(index ? [] : [{ label: 'Supplier', href: '/admin/supplier' }]),
        { label: title },
      ]}
      title={title}
      description={description}
      actions={<SideSwitch side={side} testOnly={testOnly} />}
    >
      <RouteTabs label="Supplier pages" tabs={[...SUPPLIER_TABS]} />
    </PanelHeader>
  )
}

/** A Supplier page before the admin is known: the header's shape, then its cards. */
export function SupplierPageSkeleton({ cards = 2 }: { cards?: number }) {
  return (
    <PanelPage>
      <div aria-hidden="true" className={cn(PANEL, 'h-56 animate-pulse')} />
      {Array.from({ length: cards }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
        <div key={index} aria-hidden="true" className={cn(PANEL, 'h-72 animate-pulse')} />
      ))}
    </PanelPage>
  )
}

/** A card of tiles while it loads. */
export function TilesSkeleton({ count }: { count: number }) {
  return (
    <div aria-hidden="true" className={cn(PANEL, 'space-y-4 p-5 sm:p-6')}>
      <div className="h-5 w-40 animate-pulse rounded bg-muted" />
      <div className="grid grid-cols-1 gap-3 min-[26rem]:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: count }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
          <div key={index} className="h-24 animate-pulse rounded-2xl bg-muted" />
        ))}
      </div>
    </div>
  )
}
