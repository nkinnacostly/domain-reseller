'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

/**
 * A navigation link that knows whether it points at the current page.
 *
 * `aria-current="page"` is the part that matters — it is how a screen reader
 * announces "you are here", and no amount of styling substitutes for it.
 * The visual treatment pairs colour with an underline, because colour alone
 * is not an acceptable signal (WCAG 1.4.1).
 */
export function isCurrentPath(href: string, pathname: string, exact = false): boolean {
  const [path = '/', hash] = href.split('#')

  /**
   * A pure same-page anchor such as `/#how-it-works` is a jump to a section,
   * not a page. Marking it current would leave a nav item permanently
   * underlined on the home page — constant, so it carries no information, and
   * it reads as "you are on the How it works page" when you are in the hero.
   * The indicator is reserved for navigation that actually changes page.
   */
  if (hash !== undefined && (path === '' || path === pathname)) return false

  if (path === '/' || exact) return pathname === path
  return pathname === path || pathname.startsWith(`${path}/`)
}

type NavLinkProps = {
  href: string
  children: React.ReactNode
  className?: string
  activeClassName?: string
  onClick?: () => void
  /** Current only on this exact path, not its children — for an index tab. */
  exact?: boolean
  /**
   * Whether this link is the current page, when the path cannot say: tabs
   * that share one path and differ by `?tab=`. Unset, the path decides.
   */
  current?: boolean
}

export function NavLink({
  href,
  children,
  className,
  activeClassName,
  onClick,
  exact,
  current,
}: NavLinkProps) {
  const pathname = usePathname()
  const isCurrent = current ?? isCurrentPath(href, pathname, exact)

  return (
    <Link
      href={href}
      onClick={onClick}
      aria-current={isCurrent ? 'page' : undefined}
      data-current={isCurrent ? 'true' : undefined}
      className={cn(
        'relative transition-colors',
        isCurrent ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
        isCurrent && activeClassName,
        className,
      )}
    >
      {children}
    </Link>
  )
}
