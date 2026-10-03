import { Suspense } from 'react'
import { PanelHeader, PanelPage } from '@/components/layout/panel'
import { SideSwitch } from '@/features/admin/components/shell/side-switch'
import { sideName } from '@/features/admin/lib/money-copy'
import {
  byGrain,
  formatSpan,
  MAX_SPAN_DAYS,
  type MoneyParams,
  parseMoneyParams,
} from '@/features/admin/lib/money-params'
import { getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import { MarginSection } from './margin-section'
import { MoneyControls } from './money-controls'
import { MarginSkeleton, RevenueSkeleton } from './money-skeleton'
import { RevenueSection } from './revenue-section'

export type MoneySearch = Record<string, string | string[] | undefined>

/** What the page covers, in words: the side, the dates and the grain. */
export function moneyDescription(side: 'live' | 'test', params: MoneyParams): string {
  return `Sales, VAT, refunds, fees and margin on ${sideName(side)}, ${formatSpan(params.from, params.to)}, ${byGrain(params.grain)}.`
}

/**
 * `/admin/money` (docs/ADMIN-SPEC.md §5.2 B7): sales, VAT, cash, refunds and
 * fees by day, week or month, and margin on known cost, on the side the
 * admin is looking at. The dates and grain are in the URL — the overview
 * links here with `?from=&to=` (§9's link contract). Read only: the page
 * offers no actions but saving what it shows as CSV.
 */
export async function MoneyView({ searchParams }: { searchParams: Promise<MoneySearch> }) {
  const admin = await requireAdmin()
  const [side, search] = await Promise.all([getAdminSide(admin), searchParams])
  // After the session's cookies are read, so the clock is this request's (CLAUDE.md §15).
  const now = new Date()
  const params = parseMoneyParams(search, now)

  return (
    <PanelPage>
      <PanelHeader
        crumbs={[{ label: 'Admin', href: '/admin' }, { label: 'Money' }]}
        title="Money"
        description={moneyDescription(side, params)}
        actions={<SideSwitch side={side} testOnly={admin.testOnly} />}
      >
        <MoneyControls params={params} />
        {params.clamped ? (
          <p role="status" className="mt-3 text-sm text-muted-foreground">
            Dates are limited to {MAX_SPAN_DAYS.toLocaleString('en-GB')} days at a time, so this
            starts on the earliest day allowed.
          </p>
        ) : null}
      </PanelHeader>
      <Suspense fallback={<RevenueSkeleton />}>
        <RevenueSection side={side} params={params} now={now} />
      </Suspense>
      <Suspense fallback={<MarginSkeleton />}>
        <MarginSection side={side} params={params} />
      </Suspense>
    </PanelPage>
  )
}
