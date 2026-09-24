import { formatNaira } from '@dr/shared'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Suspense } from 'react'
import { FOCUS, PANEL, PanelHeader, PanelPage, PanelSkeleton } from '@/components/layout/panel'
import { CheckoutForm } from '@/features/checkout/components/checkout-form'
import { getCheckoutView } from '@/features/checkout/queries/checkout'
import { profileOption } from '@/features/contacts/lib/profiles'
import { listContactProfiles } from '@/features/contacts/queries/profiles'
import { getNameserverPresets } from '@/features/domains/queries/domains'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Checkout' }

async function Checkout() {
  const [view, presets, profiles] = await Promise.all([
    getCheckoutView(),
    getNameserverPresets(),
    listContactProfiles(),
  ])
  if (!view || view.cart.state === 'empty') redirect('/cart')

  const back = (message: string) => (
    <div className={cn(PANEL, 'p-5 sm:p-7')}>
      <p className="max-w-xl text-pretty text-foreground">{message}</p>
      <Link
        href="/cart"
        className={cn(
          'mt-4 inline-flex h-11 items-center rounded-full bg-accent px-6 text-sm font-medium text-accent-foreground transition hover:bg-accent/90 active:scale-[0.98]',
          FOCUS,
        )}
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
  if (!view.open) {
    return back(
      "Checkout isn't open yet. Your domains stay in your cart, and nothing has been charged.",
    )
  }
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
      presets={presets}
      profiles={(profiles ?? []).map(profileOption)}
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
    <PanelPage>
      <PanelHeader
        crumbs={[
          { label: 'Home', href: '/' },
          { label: 'Cart', href: '/cart' },
          { label: 'Checkout' },
        ]}
        title="Checkout"
        description="Who owns the domains, then payment with Flutterwave. Every name is checked again, and the price confirmed, before you pay."
      />
      <Suspense fallback={<PanelSkeleton height="h-[32rem]" />}>
        <Checkout />
      </Suspense>
    </PanelPage>
  )
}
