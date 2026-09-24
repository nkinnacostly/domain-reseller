import { ArrowUpRight } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import type { Summary } from '../../lib/dashboard'
import { FOCUS, PANEL, plural } from './panel'

/**
 * Five things that may need doing, each counted and one tap from being done.
 * The dot says whether it needs attention; the words always say it too.
 */
export function AttentionTiles({
  summary,
  twoFactorOn,
  className,
}: {
  summary: Summary
  twoFactorOn: boolean
  className?: string
}) {
  const tiles = [
    {
      label: 'Due this week',
      value: plural(summary.dueWithin7, 'domain'),
      attention: summary.dueWithin7 > 0,
      href: '/app/domains?within=7#portfolio',
      action: 'View',
      detail: 'domains due this week',
    },
    {
      label: 'Auto-renew off',
      value: plural(summary.autoRenewOff, 'domain'),
      attention: summary.autoRenewOff > 0,
      href: '/app/domains#portfolio',
      action: 'Review',
      detail: 'domains that renew by hand',
    },
    {
      label: 'Nameservers',
      value: `${summary.nameservers.notSet} not set`,
      attention: summary.nameservers.notSet > 0,
      href: summary.firstNotPointed
        ? `/app/domains/${summary.firstNotPointed}/nameservers`
        : '/app/domains#portfolio',
      action: 'Set up',
      detail: 'nameservers',
    },
    {
      label: 'Awaiting payment',
      value: plural(summary.awaitingPayment, 'order'),
      attention: summary.awaitingPayment > 0,
      href: '/app/orders',
      action: 'View',
      detail: 'orders awaiting payment',
    },
    {
      label: 'Two-factor sign-in',
      value: twoFactorOn ? 'On' : 'Off',
      attention: !twoFactorOn,
      href: '/app/settings#two-factor',
      action: twoFactorOn ? 'Manage' : 'Turn on',
      detail: 'two-factor sign-in',
    },
  ]

  return (
    <section aria-labelledby="attention-heading" className={className}>
      <h2 id="attention-heading" className="sr-only">
        Things to check
      </h2>
      <ul className="grid h-full grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((tile) => (
          <li key={tile.label} className={cn(PANEL, 'flex min-h-36 flex-col rounded-2xl p-3.5')}>
            <span
              aria-hidden="true"
              className={cn(
                'size-2.5 rounded-full',
                tile.attention ? 'bg-status-expiring' : 'bg-status-active',
              )}
            />
            <p className="mt-2 text-xs text-muted-foreground">{tile.label}</p>
            <p className="mt-1 text-xl font-light tracking-tight text-foreground tabular-nums">
              {tile.value}
            </p>
            <Link
              href={tile.href}
              className={cn(
                'group mt-auto flex min-h-11 items-center justify-between gap-2 pt-3 text-xs text-foreground',
                FOCUS,
              )}
            >
              <span>
                {tile.action}
                <span className="sr-only"> {tile.detail}</span>
              </span>
              <span
                aria-hidden="true"
                className="grid size-7 shrink-0 place-items-center rounded-full border border-border bg-background transition-colors group-hover:bg-brand group-hover:text-brand-foreground"
              >
                <ArrowUpRight className="size-3.5" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
