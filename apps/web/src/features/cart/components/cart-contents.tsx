import { formatNaira } from '@dr/shared'
import { ArrowRight, ShoppingCart } from 'lucide-react'
import Link from 'next/link'
import { PricingUnavailable } from '@/features/pricing/components/pricing-unavailable'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { createClient } from '@/lib/supabase/server'
import { CartCountSync } from '../lib/count'
import { toLineView, toSslLineView } from '../lib/view'
import { getCartView } from '../queries/cart'
import { AcceptPricesButton } from './accept-prices-button'
import { CartLine } from './cart-line'
import { SslCartLine } from './ssl-cart-line'

export async function CartContents() {
  const view = await getCartView()

  if (view.state === 'empty') {
    return (
      <>
        <CartCountSync count={0} />
        <div className="rounded-3xl border border-border border-dashed px-6 py-14 text-center">
          <span className="mx-auto grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
            <ShoppingCart className="size-5" aria-hidden="true" />
          </span>
          <h2 className="mt-4 text-lg font-semibold text-foreground">Your cart is empty</h2>
          <p className="mx-auto mt-2 max-w-sm text-pretty text-sm/6 text-muted-foreground">
            Search for a name and add the ones you like. Each shows its renewal price before you
            commit to anything.
          </p>
          <Link
            href="/search"
            className="mt-6 inline-flex h-11 items-center gap-2 rounded-full bg-accent px-6 text-sm font-medium text-accent-foreground transition hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
          >
            Search for a domain
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
      </>
    )
  }

  if (view.state === 'unpriced') {
    return (
      <div className="max-w-2xl">
        <PricingUnavailable />
      </div>
    )
  }

  const [priced, supabase] = await Promise.all([
    view.lines.length > 0 ? getPricedCatalogue() : null,
    createClient(),
  ])
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const byTld = new Map(priced?.tlds.map((tld) => [tld.tld, tld]) ?? [])
  const lines = view.lines.map((line) => toLineView(line, byTld.get(line.tld)))
  // FR-SSL-6: certificates are listed apart from domains, with their own terms.
  const certificates = view.certificates.map(toSslLineView)
  const { totals } = view
  const summary = [
    lines.length > 0 ? `${lines.length} ${lines.length === 1 ? 'domain' : 'domains'}` : null,
    certificates.length > 0
      ? `${certificates.length} ${certificates.length === 1 ? 'certificate' : 'certificates'}`
      : null,
  ]
    .filter(Boolean)
    .join(', ')

  return (
    <div className="grid gap-10 lg:grid-cols-[1.7fr_1fr] lg:gap-14">
      <CartCountSync count={lines.length + certificates.length} />

      <div>
        {totals.needsAcknowledgement ? (
          <div
            role="status"
            className="mb-6 flex flex-col gap-3 rounded-2xl bg-muted/60 p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <p className="text-pretty text-sm/6 text-foreground">
              Prices are held for {view.lockMinutes} minutes. Some have changed since you added them
              — the new prices are shown below.
            </p>
            <AcceptPricesButton />
          </div>
        ) : null}

        {lines.length > 0 ? (
          <ul aria-label="Domains in your cart" className="divide-y divide-border/70">
            {lines.map((line) => (
              <CartLine key={line.id} line={line} />
            ))}
          </ul>
        ) : null}
        {certificates.length > 0 ? (
          <ul
            aria-label="SSL certificates in your cart"
            className={
              lines.length > 0
                ? 'mt-6 divide-y divide-border/70 border-border border-t pt-6'
                : 'divide-y divide-border/70'
            }
          >
            {certificates.map((line) => (
              <SslCartLine key={line.id} line={line} />
            ))}
          </ul>
        ) : null}
      </div>

      <aside
        aria-labelledby="summary-heading"
        className="h-fit rounded-3xl border border-border bg-background p-6 lg:sticky lg:top-8"
      >
        <h2 id="summary-heading" className="text-lg font-semibold text-foreground">
          Order summary
        </h2>
        <dl className="mt-5 space-y-3 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{summary}</dt>
            <dd className="font-medium text-foreground tabular-nums">
              {formatNaira(totals.subtotalKobo)}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">VAT ({view.vatPct}%)</dt>
            <dd className="font-medium text-foreground tabular-nums">
              {formatNaira(totals.vatKobo)}
            </dd>
          </div>
          <div className="flex justify-between gap-4 border-border border-t pt-3 text-base">
            <dt className="font-semibold text-foreground">Total</dt>
            <dd className="font-bold text-foreground tabular-nums">
              {formatNaira(totals.totalKobo)}
            </dd>
          </div>
        </dl>
        {totals.unavailableCount > 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            Leaves out {totals.unavailableCount} {certificates.length > 0 ? 'item' : 'domain'}
            {totals.unavailableCount === 1 ? '' : 's'} we no longer sell.
          </p>
        ) : null}

        {totals.needsAcknowledgement || totals.unavailableCount > 0 ? (
          <p className="mt-6 text-pretty text-sm/6 text-muted-foreground">
            Accept the new prices, or remove what we no longer sell, to continue.
          </p>
        ) : (
          <Link
            href={user ? '/app/checkout' : '/sign-in?next=%2Fapp%2Fcheckout'}
            className="mt-6 inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-accent px-6 text-base font-medium text-accent-foreground transition hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
          >
            {user ? 'Continue to checkout' : 'Sign in to check out'}
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        )}
        <p className="mt-3 text-pretty text-xs/5 text-muted-foreground">
          {user
            ? 'Your cart is saved to your account.'
            : 'Your cart is saved in this browser, and moves to your account when you sign in.'}
        </p>
      </aside>
    </div>
  )
}

export function CartSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="grid animate-pulse gap-10 lg:grid-cols-[1.7fr_1fr] lg:gap-14"
    >
      <div className="h-80 rounded-3xl bg-muted" />
      <div className="h-64 rounded-3xl bg-muted" />
    </div>
  )
}
