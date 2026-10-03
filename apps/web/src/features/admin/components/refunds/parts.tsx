import Link from 'next/link'
import { FOCUS } from '@/components/layout/panel'
import { RouteTabs } from '@/features/admin/components/route-tabs'
import { cn } from '@/lib/utils'

/**
 * Small pieces the three refunds pages share. Server-safe: a constant
 * exported from a 'use client' module reaches a server component as a
 * client reference, not a string, so the classes live here.
 */

/** A secondary link or button, pressed and disabled states included (S12). */
export const QUIET_LINK = cn(
  'inline-flex h-11 items-center justify-center gap-2 rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition hover:bg-muted active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70',
  FOCUS,
)

/** Refunds and their incidents are two tabs of one area (S13: the open one is marked). */
export function RefundsTabs({
  needPerson,
  openIncidents,
}: {
  needPerson: number | null
  openIncidents: number | null
}) {
  return (
    <RouteTabs
      label="Refunds and payment incidents"
      tabs={[
        {
          href: '/admin/refunds',
          label: 'Refunds',
          exact: true,
          ...(needPerson !== null ? { count: needPerson } : {}),
        },
        {
          href: '/admin/refunds/incidents',
          label: 'Payment incidents',
          ...(openIncidents !== null ? { count: openIncidents } : {}),
        },
      ]}
    />
  )
}

/** "Back to refunds", for a page that found nothing. */
export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className={QUIET_LINK}>
      {children}
    </Link>
  )
}

/** A card's heading, with an id for the card's accessible name. */
export function CardHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="font-medium text-foreground">
      {children}
    </h2>
  )
}
