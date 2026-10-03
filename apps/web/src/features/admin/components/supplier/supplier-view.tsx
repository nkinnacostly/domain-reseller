import { Suspense } from 'react'
import { PANEL_HEADING, Panel, PanelPage, PanelSkeleton } from '@/components/layout/panel'
import { ErrorState } from '@/features/admin/components/error-state'
import { StatTile } from '@/features/admin/components/stat-tile'
import type { AdminSide } from '@/features/admin/lib/side'
import { balanceTiles, ledgerReadLine } from '@/features/admin/lib/supplier-float'
import { getAttentionCounts } from '@/features/admin/queries/attention'
import { getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import { getSupplierFloat } from '@/features/admin/queries/supplier'
import { BalanceCharts } from './balance-charts'
import { LiveBalance } from './live-balance'
import { SupplierHeader, TilesSkeleton } from './supplier-header'
import { TopupsSection } from './topups-section'

/** Inside a card, a tile is a lighter well rather than a second card. */
const INNER_TILE = 'h-full rounded-2xl bg-background/70 pr-10 shadow-none dark:bg-background/40'

/**
 * `/admin/supplier` — the float (docs/ADMIN-SPEC.md §5.2 B6, §6): the
 * balance tiles from `admin_float`, a live read on request, the 90-day close
 * and the ledger's debits and credits, and our top-ups. Each section streams
 * on its own, with its own loading and error states (S11).
 */
export async function SupplierView() {
  const admin = await requireAdmin()
  const side = await getAdminSide(admin)
  // After the session's cookies are read, so the clock is this request's (CLAUDE.md §15).
  const now = new Date()
  return (
    <PanelPage>
      <SupplierHeader
        title="Supplier"
        description="DomainNameAPI's balance, burn and runway, and what our top-ups cost."
        side={side}
        testOnly={admin.testOnly}
      />
      <Suspense fallback={<TilesSkeleton count={8} />}>
        <BalanceSection side={side} now={now} />
      </Suspense>
      <Suspense fallback={<ChartsSkeleton />}>
        <BalanceCharts admin={admin} side={side} now={now} />
      </Suspense>
      <Suspense fallback={<PanelSkeleton height="h-56" />}>
        <TopupsSection admin={admin} side={side} />
      </Suspense>
    </PanelPage>
  )
}

export async function BalanceSection({ side, now }: { side: AdminSide; now: Date }) {
  const [float, counts] = await Promise.all([getSupplierFloat(side), getAttentionCounts(side)])
  if (!float) {
    return (
      <ErrorState
        title="The balance couldn't be loaded."
        body="Nothing was changed. Try again; the live read below still asks DomainNameAPI directly."
      />
    )
  }
  const tiles = balanceTiles(float, now, counts ? counts.ledgerUnexplained : null)
  return (
    <Panel labelledBy="supplier-balance-heading">
      <h2 id="supplier-balance-heading" className={PANEL_HEADING}>
        Balance
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        DomainNameAPI balance on the {side} side, in US dollars. {ledgerReadLine(float, now)}
      </p>
      <ul className="mt-4 grid grid-cols-1 gap-3 min-[26rem]:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <li key={tile.key} className="min-w-0" data-tile={tile.key}>
            <StatTile
              label={tile.label}
              value={tile.value}
              hint={tile.hint}
              tone={tile.tone}
              {...(tile.href ? { href: tile.href } : {})}
              className={INNER_TILE}
            />
          </li>
        ))}
      </ul>
      <div className="mt-6 border-border border-t pt-5">
        <h3 className="text-sm font-medium text-foreground">Live balance</h3>
        <div className="mt-2">
          <LiveBalance snapshotCents={float.balanceCents ?? null} takenAt={float.takenAt ?? null} />
        </div>
      </div>
    </Panel>
  )
}

function ChartsSkeleton() {
  return (
    <div aria-hidden="true" className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <PanelSkeleton height="h-72" />
      <PanelSkeleton height="h-72" />
    </div>
  )
}
