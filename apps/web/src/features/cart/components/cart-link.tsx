'use client'

import { ShoppingCart } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { useCartCount } from '../lib/count'

const TONE = {
  /** On the brand-blue headers — hence white. */
  onBrand: {
    link: 'text-brand-foreground hover:bg-brand-foreground/10 focus-visible:outline-brand-foreground',
    badge: 'bg-brand-foreground text-brand',
  },
  /** On a card, as in the panel's sidebar. */
  default: {
    link: 'border border-border bg-background text-foreground hover:bg-muted focus-visible:outline-ring',
    badge: 'bg-brand text-brand-foreground',
  },
} as const

/** The cart icon, with the number of domains in it. */
export function CartLink({
  className,
  tone = 'onBrand',
}: {
  className?: string
  tone?: keyof typeof TONE
}) {
  const count = useCartCount()
  const label = count === 0 ? 'Cart' : `Cart, ${count} ${count === 1 ? 'domain' : 'domains'}`

  return (
    <Link
      href="/cart"
      aria-label={label}
      className={cn(
        'relative grid size-11 shrink-0 place-items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 active:scale-[0.97]',
        TONE[tone].link,
        className,
      )}
    >
      <ShoppingCart className="size-5" aria-hidden="true" />
      {count > 0 ? (
        <span
          aria-hidden="true"
          className={cn(
            'absolute top-1 right-0.5 grid min-w-5 place-items-center rounded-full px-1 text-[0.6875rem] font-semibold tabular-nums',
            TONE[tone].badge,
          )}
        >
          {count}
        </span>
      ) : null}
    </Link>
  )
}
