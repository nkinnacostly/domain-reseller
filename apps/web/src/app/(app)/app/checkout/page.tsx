import { formatNaira } from '@dr/shared'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Suspense } from 'react'
import { Container } from '@/components/layout/site-shell'
import { CheckoutForm } from '@/features/checkout/components/checkout-form'
import { getCheckoutView } from '@/features/checkout/queries/checkout'

export const metadata: Metadata = { title: 'Checkout' }

async function Checkout() {
  const view = await getCheckoutView()
  if (!view || view.cart.state === 'empty') redirect('/cart')

  const back = (message: string) => (
    <div className="max-w-xl rounded-2xl border border-border p-6">
      <p className="text-pretty text-foreground">{message}</p>
      <Link
        href="/cart"
        className="mt-4 inline-flex h-11 items-center rounded-full bg-accent px-6 text-sm font-medium text-accent-foreground transition hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        Back to your cart
      </Link>
    </div>
  )

  if (view.cart.state === 'unpriced')
    return back(
      'Prices are unavailable right now, so checkout is paused. Nothing has been charged.',
    )
  if (!view.paymentsConfigured) return back('Payments are not set up yet, so checkout is paused.')
  const { lines, totals } = view.cart
  if (totals.needsAcknowledgement || totals.unavailableCount > 0) {
    return back(
      'Something in your cart changed — a price, or an extension we no longer sell. Review it first.',
    )
  }

  return (
    <CheckoutForm
      testMode={view.testMode}
      registrant={view.registrant}
      lines={lines.map((line) => ({
        domain: line.domain,
        years: line.periodYears,
        total: formatNaira(line.payableKobo),
        renewal: formatNaira(line.renewalKobo),
        includesIcannFee: line.includesIcannFee,
      }))}
      summary={{
        subtotal: formatNaira(totals.subtotalKobo),
        vatPct: view.cart.vatPct,
        vat: formatNaira(totals.vatKobo),
        total: formatNaira(totals.totalKobo),
        totalKobo: totals.totalKobo,
      }}
    />
  )
}

export default function CheckoutPage() {
  return (
    <Container className="py-10 sm:py-14">
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Checkout</h1>
      <div className="mt-8">
        <Suspense
          fallback={
            <div aria-hidden="true" className="h-[32rem] animate-pulse rounded-3xl bg-muted" />
          }
        >
          <Checkout />
        </Suspense>
      </div>
    </Container>
  )
}
