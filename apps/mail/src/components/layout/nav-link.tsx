'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

/**
 * A navigation link that knows whether it is the current page (S13):
 * `aria-current="page"` for screen readers, and an underline beside the
 * colour, because colour alone is not a signal (WCAG 1.4.1). Active colours
 * go on `data-[current=true]:` in the base classes, as in the shop.
 */
export function isCurrentPath(href: string, pathname: string, exact = false): boolean {
  const [path = '/', hash] = href.split('#')
  // A same-page anchor is a jump, not a page.
  if (hash !== undefined && (path === '' || path === pathname)) return false
  if (path === '/' || exact) return pathname === path
  return pathname === path || pathname.startsWith(`${path}/`)
}

export function NavLink({
  href,
  children,
  className,
  exact,
}: {
  href: string
  children: React.ReactNode
  className?: string
  exact?: boolean
}) {
  const pathname = usePathname()
  const current = isCurrentPath(href, pathname, exact)
  return (
    <Link
      href={href}
      aria-current={current ? 'page' : undefined}
      data-current={current ? 'true' : undefined}
      className={cn(
        'rounded-md text-muted-foreground underline-offset-8 transition-colors hover:text-foreground',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        'data-[current=true]:font-medium data-[current=true]:text-foreground data-[current=true]:underline data-[current=true]:decoration-2',
        className,
      )}
    >
      {children}
    </Link>
  )
}
