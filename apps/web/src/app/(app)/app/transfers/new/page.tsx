import { formatNaira, vatKobo } from '@dr/shared'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import {
  FOCUS,
  PANEL_HEADING,
  Panel,
  PanelHeader,
  PanelPage,
  PanelPageSkeleton,
} from '@/components/layout/panel'
import { TransferChecklist } from '@/features/transfers/components/transfer-checklist'
import { TransferCheckoutForm } from '@/features/transfers/components/transfer-checkout-form'
import { transferCheckHref } from '@/features/transfers/lib/href'
import { getTransferCheckoutView } from '@/features/transfers/queries/transfer-checkout'
import { BUSINESS } from '@/lib/business'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Transfer a domain in' }

type Search = Promise<{ domain?: string | string[] }>

const CRUMBS = [
  { label: 'Home', href: '/' },
  { label: 'Dashboard', href: '/app/domains' },
  { label: 'Transfer in' },
]

const BUTTON = cn(
  'mt-5 inline-flex h-11 items-center rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition hover:bg-brand-subtle active:scale-[0.98]',
  FOCUS,
)

/** Why a payment is not offered, what to do instead, and nothing charged. */
function Stop({
  title,
  message,
  action,
  children,
}: {
  title: string
  message: string
  action?: { href: string; label: string }
  children?: React.ReactNode
}) {
  return (
    <>
      <PanelHeader crumbs={CRUMBS} title={<span className="break-all">{title}</span>} />
      <Panel labelledBy="stop-heading" className="max-w-3xl">
        <h2 id="stop-heading" className={PANEL_HEADING}>
          Nothing has been charged
        </h2>
        <p className="mt-2 text-pretty text-sm/6 text-foreground">{message}</p>
        {children}
        {action ? (
          <Link href={action.href} className={BUTTON}>
            {action.label}
          </Link>
        ) : null}
      </Panel>
    </>
  )
}

async function TransferIn({ searchParams }: { searchParams: Search }) {
  const { domain: raw } = await searchParams
  const view = await getTransferCheckoutView((Array.isArray(raw) ? raw[0] : raw) ?? '')
  if (!view) notFound()

  const check = { href: '/transfer', label: 'Check a domain' }
  switch (view.state) {
    case 'invalid':
      return <Stop title="Transfer a domain in" message={`${view.message}.`} action={check} />
    case 'unpriced':
      return (
        <Stop
          title="Transfer a domain in"
          message="Prices are unavailable right now, so transfers are paused. Try again shortly."
        />
      )
    case 'not-offered':
      return (
        <Stop
          title={`Transfer ${view.domain}`}
          message={`We don’t take transfers for .${view.tld} yet.`}
          action={{ href: '/pricing', label: 'See every extension' }}
        />
      )
    case 'payments-off':
      return (
        <Stop
          title="Transfer a domain in"
          message="Payments aren’t set up here, so transfers are paused."
        />
      )
    case 'closed':
      return (
        <Stop
          title="Transfer a domain in"
          message="Payments aren’t open yet, so transfers are paused."
        />
      )
    case 'yours':
      return (
        <Stop
          title={`Transfer ${view.domain}`}
          message={`${view.domain} is already on your account, so there is nothing to transfer.`}
          action={{ href: `/app/domains/${view.domain}`, label: 'Open the domain' }}
        />
      )
    case 'under-way':
      return (
        <Stop
          title={`Transfer ${view.domain}`}
          message={`A transfer of ${view.domain} is already paid for and under way. Its page shows how it is going.`}
          action={{ href: `/app/domains/${view.domain}`, label: 'Follow the transfer' }}
        />
      )
    case 'held':
      return (
        <Stop
          title={`Transfer ${view.domain}`}
          message={`${view.domain} is already registered with us, so it can’t be transferred in. If it is yours on another account, email ${BUSINESS.email}.`}
        />
      )
    case 'blocked':
      return (
        <Stop
          title={`Transfer ${view.domain}`}
          message={view.reason}
          action={{ href: transferCheckHref(view.domain), label: 'See the full check' }}
        >
          <div className="mt-6">
            <TransferChecklist checks={view.verdict.checks} />
          </div>
        </Stop>
      )
  }

  const { domain, pricing, vatPct } = view
  const subtotal = pricing.transfer.priceKobo
  const vat = vatKobo(subtotal, vatPct)

  return (
    <>
      <PanelHeader
        crumbs={CRUMBS}
        title={<span className="break-all">Transfer {domain}</span>}
        description="Your transfer code, who owns the domain, then payment with Flutterwave. The code is checked with the registry, and the price confirmed, before you pay."
      />
      <TransferCheckoutForm
        domain={domain}
        registrant={view.registrant}
        testMode={view.testMode}
        summary={{
          transfer: formatNaira(subtotal),
          renewal: formatNaira(pricing.renewal.priceKobo),
          vatPct,
          vat: formatNaira(vat),
          total: formatNaira(subtotal + vat),
          totalKobo: subtotal + vat,
          includesIcannFee: !pricing.isCountryCode,
        }}
      />
      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <Panel labelledBy="registry-heading">
          <h2 id="registry-heading" className={PANEL_HEADING}>
            What the registry shows
          </h2>
          <p className="mt-1.5 mb-5 text-pretty text-sm/6 text-muted-foreground">
            Looked up live just now. Items marked “Check yourself” are covered when we check your
            code before you pay.
          </p>
          <TransferChecklist checks={view.verdict.checks} />
        </Panel>
        <Panel labelledBy="next-heading" className="h-fit text-sm/6">
          <h2 id="next-heading" className={PANEL_HEADING}>
            What happens next
          </h2>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-pretty text-muted-foreground">
            <li>Once you have paid, we send the transfer request to the registry.</li>
            <li>
              Your current registrar may email the domain’s owner to approve it. If they don’t
              answer, the registry completes the transfer after five days — so it usually takes up
              to five days, and often less.
            </li>
            <li>
              We don’t change your nameservers, so the domain keeps pointing where it points now. If
              your current registrar hosts your DNS, copy it to your web host first — some delete it
              when a domain leaves.
            </li>
            <li>
              Your order page shows each step. If the transfer is refused, what you paid is refunded
              automatically.
            </li>
          </ol>
        </Panel>
      </div>
    </>
  )
}

/** PRD FR-T1, FR-T2 — start a transfer in: the code, the owner, the price, then payment. */
export default function TransferInPage({ searchParams }: { searchParams: Search }) {
  return (
    <PanelPage>
      <Suspense fallback={<PanelPageSkeleton height="h-[32rem]" />}>
        <TransferIn searchParams={searchParams} />
      </Suspense>
    </PanelPage>
  )
}
