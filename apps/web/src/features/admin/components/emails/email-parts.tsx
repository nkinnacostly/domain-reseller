import { Check, Info } from 'lucide-react'
import Link from 'next/link'
import { FOCUS } from '@/components/layout/panel'
import { TAB_LABEL } from '@/features/admin/lib/emails-copy'
import { EMAIL_TABS, type EmailTab, emailsTabHref } from '@/features/admin/lib/emails-params'
import { formatWatDate, formatWatTime, shortId } from '@/features/admin/lib/format'
import { adminHref } from '@/features/admin/lib/href'
import { cn } from '@/lib/utils'

/** The emails page's small pieces (docs/ADMIN-SPEC.md §5.2, B11). Server-safe. */

/** A link inside a row or a sentence; at least 44px tall where it stands alone (S7). */
export const LINK = cn(
  'inline-flex min-h-11 items-center rounded break-all text-foreground underline underline-offset-4 hover:no-underline active:opacity-80',
  FOCUS,
)

/** A secondary link or form button, pressed and disabled states included (S12). */
export const QUIET_LINK = cn(
  'inline-flex h-11 items-center justify-center gap-2 rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition hover:bg-muted active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70',
  FOCUS,
)

/**
 * The two views as links: the URL says which is open (`?tab=`). The open one
 * carries `aria-current="page"`, a tick and heavier words — never colour
 * alone (S13). NavLink judges by path only, and both share one path.
 */
export function EmailTabs({ current }: { current: EmailTab }) {
  return (
    <nav aria-label="Email views" className="relative -mx-1 overflow-x-auto px-1 py-1">
      <ul className="flex min-w-max gap-2">
        {EMAIL_TABS.map((tab) => {
          const isCurrent = tab === current
          return (
            <li key={tab}>
              <Link
                href={emailsTabHref(tab)}
                aria-current={isCurrent ? 'page' : undefined}
                data-current={isCurrent ? 'true' : undefined}
                className={cn(
                  'inline-flex h-11 items-center gap-1.5 rounded-full border border-border bg-background px-4 text-sm text-muted-foreground transition hover:bg-brand-subtle hover:text-foreground active:scale-[0.98]',
                  'data-[current=true]:border-brand data-[current=true]:bg-brand data-[current=true]:font-medium data-[current=true]:text-brand-foreground',
                  FOCUS,
                )}
              >
                {isCurrent ? <Check className="size-3.5" aria-hidden="true" /> : null}
                {TAB_LABEL[tab]}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

/**
 * A time in a table cell: the day, then the time in WAT, each kept whole, so
 * a narrow column breaks between them rather than inside "3 Oct 2026".
 */
export function When({ at, none = '—' }: { at: string | null | undefined; none?: string }) {
  if (!at) return <span className="text-muted-foreground">{none}</span>
  return (
    <time dateTime={at}>
      <span className="whitespace-nowrap">{formatWatDate(at)}</span>{' '}
      <span className="whitespace-nowrap">{formatWatTime(at)}</span>
    </time>
  )
}

/** An address as SQL masked it (`a•••@gmail.com`); the address itself never reaches the page. */
export function Masked({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-muted-foreground">—</span>
  return <span className="font-mono text-xs break-all">{value}</span>
}

/** What an email or a notice was about, linked by id — never by a name or an address (N13). */
export function RelatedLinks({
  orderId,
  orderNumber,
  domainId,
  userId,
}: {
  orderId?: string | null
  orderNumber?: string | null
  domainId?: string | null
  userId?: string | null
}) {
  const links: { href: string; label: string }[] = []
  if (orderId) links.push({ href: adminHref.order(orderId), label: orderNumber ?? 'Order' })
  if (domainId) links.push({ href: adminHref.domain(domainId), label: 'Domain' })
  if (userId) links.push({ href: adminHref.customer(userId), label: `Account ${shortId(userId)}` })
  if (links.length === 0) return <span className="text-muted-foreground">—</span>
  return (
    <span className="inline-flex flex-wrap justify-end gap-x-3 sm:justify-start">
      {links.map((link) => (
        <Link key={link.href} href={link.href} className={LINK}>
          {link.label}
        </Link>
      ))}
    </span>
  )
}

/** A line that explains how a list behaves. */
export function Note({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <p
      role="note"
      data-testid={testId}
      className="flex items-start gap-2 px-1 text-sm text-muted-foreground"
    >
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 text-pretty">{children}</span>
    </p>
  )
}
