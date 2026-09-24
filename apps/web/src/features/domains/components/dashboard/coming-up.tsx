import { formatNaira } from '@dr/shared'
import { ArrowUpRight, CalendarDays } from 'lucide-react'
import Link from 'next/link'
import { OrderStatus } from '@/features/checkout/components/order-status'
import { cn } from '@/lib/utils'
import { describeEvent } from '../../lib/activity'
import { relativeDays } from '../../lib/dashboard'
import type { PortfolioDomain } from '../../lib/portfolio'
import type { RecentEvent } from '../../queries/domains'
import { ComingUpTabs } from './coming-up-tabs'
import { FOCUS, PANEL, ROUND_LINK } from './panel'

/**
 * What is next and what just happened: the soonest renewals, the latest
 * orders and the latest events on any domain. Three of each; every item links
 * to where it can be acted on.
 */

export type RecentOrder = {
  id: string
  order_number: string
  status: string
  total_kobo: number | string
  test_mode: boolean
  created_at: string
  order_items: { domain: string }[]
}

const LAGOS = 'Africa/Lagos'
const shortDate = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: LAGOS,
})

type Item = {
  key: string
  title: string
  subtitle: string
  pills: React.ReactNode[]
  href: string
  open: string
}

function Items({ items, empty }: { items: Item[]; empty: string }) {
  if (items.length === 0) {
    return (
      <p className="rounded-2xl border border-border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
        {empty}
      </p>
    )
  }
  return (
    <ul className="space-y-3">
      {items.map((item, index) => (
        <li
          key={item.key}
          className={cn(
            'relative rounded-2xl border p-4',
            index === 0
              ? 'border-brand-subtle-border bg-linear-to-b from-brand/15 to-brand-subtle'
              : 'border-border bg-background/80',
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium break-words text-foreground">{item.title}</p>
              <p className="mt-1 text-sm break-words text-muted-foreground">{item.subtitle}</p>
            </div>
            <Link
              href={item.href}
              aria-label={item.open}
              className={cn(
                'grid size-9 shrink-0 place-items-center rounded-full bg-foreground text-background transition-transform after:absolute after:-inset-1 active:scale-[0.97]',
                FOCUS,
              )}
            >
              <ArrowUpRight className="size-4" aria-hidden="true" />
            </Link>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {item.pills.map((pill, pillIndex) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: pills are fixed per item
                key={pillIndex}
                className="inline-flex items-center rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground"
              >
                {pill}
              </span>
            ))}
          </div>
        </li>
      ))}
    </ul>
  )
}

export function ComingUp({
  upcoming,
  orders,
  events,
  now,
  className,
}: {
  upcoming: PortfolioDomain[]
  orders: RecentOrder[]
  events: RecentEvent[]
  now: Date
  className?: string
}) {
  const renewals: Item[] = upcoming.slice(0, 3).map((domain) => ({
    key: domain.id,
    title: domain.domainName,
    subtitle: domain.autoRenew
      ? 'Auto-renew is on'
      : 'Auto-renew is off: renew it by hand before it lapses',
    pills: [
      shortDate.format(new Date(domain.expiresAt as string)),
      relativeDays(domain.expiresAt as string, now),
    ],
    href: `/app/domains/${domain.domainName}`,
    open: `Open ${domain.domainName}`,
  }))

  const recentOrders: Item[] = orders.slice(0, 3).map((order) => ({
    key: order.id,
    title: `Order ${order.order_number}${order.test_mode ? ' (test)' : ''}`,
    subtitle: order.order_items.map((item) => item.domain).join(', ') || 'No domains',
    pills: [
      <OrderStatus key="status" status={order.status} className="bg-transparent p-0 font-normal" />,
      formatNaira(Number(order.total_kobo)),
      shortDate.format(new Date(order.created_at)),
    ],
    href: `/app/orders/${order.id}`,
    open: `Open order ${order.order_number}`,
  }))

  const activity: Item[] = events.slice(0, 3).map((event) => ({
    key: String(event.id),
    title: describeEvent(event.type, event.payload),
    subtitle: event.domainName,
    pills: [shortDate.format(new Date(event.createdAt))],
    href: `/app/domains/${event.domainName}/activity`,
    open: `Activity for ${event.domainName}`,
  }))

  return (
    <section aria-labelledby="coming-up-heading" className={cn(PANEL, 'p-5', className)}>
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1.5 text-xs whitespace-nowrap text-muted-foreground">
          <CalendarDays className="size-3.5" aria-hidden="true" />
          <time dateTime={now.toISOString()}>{shortDate.format(now)}</time>
        </span>
        <h2 id="coming-up-heading" className="font-medium whitespace-nowrap text-foreground">
          Coming up
        </h2>
        <Link href="/app/orders" aria-label="All orders" className={cn(ROUND_LINK, FOCUS)}>
          <ArrowUpRight className="size-4" aria-hidden="true" />
        </Link>
      </div>

      <ComingUpTabs
        panels={{
          renewals: (
            <Items items={renewals} empty="Domains you register show their renewal dates here." />
          ),
          orders: <Items items={recentOrders} empty="Your orders will appear here." />,
          activity: (
            <Items
              items={activity}
              empty="Registrations, renewals and nameserver changes will appear here."
            />
          ),
        }}
      />
    </section>
  )
}
