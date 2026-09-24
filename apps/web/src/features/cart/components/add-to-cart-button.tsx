'use client'

import { Check, ShoppingCart } from 'lucide-react'
import Link from 'next/link'
import { useAction } from 'next-safe-action/hooks'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { addToCart } from '../actions/cart'
import { announceCartCount } from '../lib/count'

/**
 * Adds one domain. Availability is checked again on the server before the
 * line is written, so the answer can differ from the search a moment ago —
 * and says so.
 */
export function AddToCartButton({
  domain,
  label = domain,
  size = 'default',
  className,
}: {
  /** The ASCII form, which is what the cart stores. */
  domain: string
  /** How the name reads, for the accessible name — `café.com`, not its `xn--` form (FR-S8). */
  label?: string
  size?: 'default' | 'large'
  className?: string
}) {
  const add = useAction(addToCart, {
    onSuccess: ({ data }) => {
      if (data && 'count' in data) announceCartCount(data.count)
    },
  })
  const data = add.result.data
  const added = data && 'count' in data
  const error = data && 'error' in data ? data.error : add.result.serverError

  const shape =
    size === 'large' ? 'h-12 px-6 text-base rounded-full' : 'h-10 px-4 text-sm rounded-full'

  if (added) {
    return (
      <Link
        href="/cart"
        className={cn(
          'inline-flex shrink-0 items-center justify-center gap-2 border border-accent/40 bg-accent/10 font-medium text-foreground transition hover:bg-accent/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          shape,
          className,
        )}
      >
        <Check className="size-4 text-accent" aria-hidden="true" />
        In your cart — view
      </Link>
    )
  }

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <button
        type="button"
        onClick={() => add.execute({ domain })}
        disabled={add.isPending}
        aria-busy={add.isPending || undefined}
        aria-label={`Add ${label} to cart`}
        className={cn(
          'inline-flex shrink-0 items-center justify-center gap-2 bg-accent font-medium text-accent-foreground transition hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70',
          shape,
        )}
      >
        {add.isPending ? (
          <Spinner className="size-4" aria-hidden="true" />
        ) : (
          <ShoppingCart className="size-4" aria-hidden="true" />
        )}
        {add.isPending ? 'Adding…' : 'Add to cart'}
      </button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
