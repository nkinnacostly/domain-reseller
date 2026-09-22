'use client'

import { ShoppingCart } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { useCartCount } from '../lib/count'

export function CartLink({ className }: { className?: string }) {
  const count = useCartCount()
  const label = count === 0 ? 'Cart' : `Cart, ${count} ${count === 1 ? 'domain' : 'domains'}`

  return (
    <Link
      href="/cart"
      aria-label={label}
      className={cn(
        'relative grid size-11 shrink-0 place-items-center rounded-full text-foreground transition-colors hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        className,
      )}
    >
      <ShoppingCart className="size-5" aria-hidden="true" />
      {count > 0 ? (
        <span
          aria-hidden="true"
          className="absolute top-1 right-0.5 grid min-w-5 place-items-center rounded-full bg-accent px-1 text-[0.6875rem] font-semibold text-accent-foreground tabular-nums"
        >
          {count}
        </span>
      ) : null}
    </Link>
  )
}
