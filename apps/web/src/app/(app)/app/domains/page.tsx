import type { Metadata } from 'next'
import { Suspense } from 'react'
import { getAccount } from '@/features/auth/queries/account'
import { getOrders } from '@/features/checkout/queries/orders'
import { AttentionTiles } from '@/features/domains/components/dashboard/attention-tiles'
import { ComingUp } from '@/features/domains/components/dashboard/coming-up'
import { NameserverBars } from '@/features/domains/components/dashboard/nameserver-bars'
import { Overview } from '@/features/domains/components/dashboard/overview'
import { PANEL } from '@/features/domains/components/dashboard/panel'
import { RenewalsChart } from '@/features/domains/components/dashboard/renewals-chart'
import { Portfolio } from '@/features/domains/components/portfolio'
import { summarize } from '@/features/domains/lib/dashboard'
import { parseExpiryWindow } from '@/features/domains/lib/portfolio'
import { getPortfolio, getRecentActivity } from '@/features/domains/queries/domains'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Your domains' }

/**
 * Portfolio — the authenticated landing page (PRD FR-P1). The top is an
 * overview of the account's own domains and orders; the list below is every
 * domain, soonest expiry first, with the expiry view as a filter (FR-P5).
 */
type Search = Promise<{ q?: string; within?: string }>

async function Dashboard({ searchParams }: { searchParams: Search }) {
  const [account, domains, orders, events, params] = await Promise.all([
    getAccount(),
    getPortfolio(),
    getOrders(),
    getRecentActivity(),
    searchParams,
  ])
  const now = new Date()
  const summary = summarize(domains, orders, now)

  return (
    <div className="space-y-4">
      <Overview
        firstName={account?.fullName.split(' ')[0] || null}
        summary={summary}
        orderCount={orders.length}
        now={now}
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)_minmax(0,1fr)]">
        <ComingUp
          upcoming={summary.upcoming}
          orders={orders}
          events={events}
          now={now}
          className="md:col-span-2 xl:col-span-1 xl:row-span-2"
        />
        <RenewalsChart months={summary.renewalsByMonth} total={summary.renewalsAhead} />
        <NameserverBars nameservers={summary.nameservers} held={summary.held} />
        <AttentionTiles
          summary={summary}
          twoFactorOn={Boolean(account?.totpFactor)}
          className="md:col-span-2"
        />
      </div>

      <Portfolio
        domains={domains}
        query={params.q ?? ''}
        within={parseExpiryWindow(params.within)}
      />
    </div>
  )
}

function DashboardSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-4">
      <div className={cn(PANEL, 'h-72 animate-pulse')} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <div className={cn(PANEL, 'h-80 animate-pulse')} />
        <div className={cn(PANEL, 'h-80 animate-pulse')} />
        <div className={cn(PANEL, 'h-80 animate-pulse')} />
      </div>
      <div className={cn(PANEL, 'h-64 animate-pulse')} />
    </div>
  )
}

export default function DomainsPage({ searchParams }: { searchParams: Search }) {
  return (
    <div className="px-4 py-4 sm:px-6 sm:py-6 lg:px-0 lg:py-0">
      <Suspense fallback={<DashboardSkeleton />}>
        <Dashboard searchParams={searchParams} />
      </Suspense>
    </div>
  )
}
