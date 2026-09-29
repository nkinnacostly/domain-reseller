import { formatNaira, formatRenewal, renewalTotalKobo, vatKobo } from '@dr/shared'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { FOCUS, PANEL_HEADING, Panel, PanelSkeleton } from '@/components/layout/panel'
import { daysUntilExpiry } from '@/features/domains/lib/portfolio'
import { type RenewalOption, RenewForm } from '@/features/renewals/components/renew-form'
import { addYears, priceRise } from '@/features/renewals/lib/renewal'
import { getRenewalView } from '@/features/renewals/queries/renewal'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Renew' }

type Params = Promise<{ domain: string }>
const dateFormat = new Intl.DateTimeFormat('en-NG', { dateStyle: 'long', timeZone: 'Africa/Lagos' })

function Unavailable({ domain, message }: { domain: string; message: string }) {
  return (
    <Panel labelledBy="renew-heading" className="max-w-2xl">
      <h2 id="renew-heading" className={PANEL_HEADING}>
        Renew {domain}
      </h2>
      <p className="mt-2 text-pretty text-sm/6 text-foreground">{message}</p>
      <Link
        href={`/app/domains/${domain}`}
        className={cn(
          'mt-5 inline-flex h-10 items-center rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition hover:bg-brand-subtle active:scale-[0.98]',
          FOCUS,
        )}
      >
        Back to the overview
      </Link>
    </Panel>
  )
}

async function Renew({ params }: { params: Params }) {
  const { domain: name } = await params
  const view = await getRenewalView(name)
  if (!view) notFound()
  const { domain, pricing, check } = view

  if (!check.ok) return <Unavailable domain={domain.domainName} message={check.reason} />
  if (!view.open) {
    return (
      <Unavailable
        domain={domain.domainName}
        message="Payments aren’t open yet, so renewals are paused. Nothing has been charged."
      />
    )
  }
  // `renewability` refuses without a price or an expiry, so both are here.
  if (!pricing || !domain.expiresAt) notFound()

  const expiresAt = domain.expiresAt
  // Only the periods the registry renews in — for .ai, 2, 4, 6… years (FR-RN1).
  const options: RenewalOption[] = check.years.map((years) => {
    const subtotal = renewalTotalKobo(pricing, years)
    const vat = vatKobo(subtotal, view.vatPct)
    return {
      years,
      newExpiry: dateFormat.format(addYears(expiresAt, years)),
      subtotal: formatNaira(subtotal),
      vat: formatNaira(vat),
      total: formatNaira(subtotal + vat),
      totalKobo: subtotal + vat,
    }
  })
  const rise = priceRise(view.previousRenewalKobo, pricing.renewal.priceKobo)
  const term = pricing.renewalTerm.years
  const days = daysUntilExpiry(expiresAt, new Date())
  const expired = domain.status === 'expired_grace'

  return (
    <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
      <Panel labelledBy="renew-heading" className="h-fit">
        <h2 id="renew-heading" className={PANEL_HEADING}>
          Renew {domain.domainName}
        </h2>
        <p className="mt-1.5 text-pretty text-sm/6 text-muted-foreground">
          {expired
            ? `It expired on ${dateFormat.format(new Date(expiresAt))} and is in its grace period. Renewing now keeps it, at the normal renewal price.`
            : days !== null && days < 0
              ? `It expired on ${dateFormat.format(new Date(expiresAt))}.`
              : `It expires on ${dateFormat.format(new Date(expiresAt))}, in ${days} ${days === 1 ? 'day' : 'days'}.`}
        </p>
        <div className="mt-6">
          <RenewForm
            domainId={domain.id}
            domainName={domain.domainName}
            renewal={{ price: formatNaira(pricing.renewalTerm.priceKobo), years: term }}
            vatPct={view.vatPct}
            options={options}
            priceRise={
              rise
                ? { from: formatRenewal(rise.from, term), to: formatRenewal(rise.to, term) }
                : null
            }
            testMode={view.paymentTestMode === true}
          />
        </div>
      </Panel>

      <Panel labelledBy="how-heading" className="h-fit">
        <h2 id="how-heading" className={PANEL_HEADING}>
          How renewing works
        </h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-pretty text-sm/6 text-muted-foreground">
          <li>
            The years you buy are added to the current expiry date, so renewing early loses nothing.
          </li>
          <li>
            A registry holds a domain at most ten years ahead, so the choice above never goes past
            that.
          </li>
          <li>
            We read the new expiry back from the registry before we call it done. Its progress shows
            on your order page and in this domain’s activity.
          </li>
        </ul>
      </Panel>
    </div>
  )
}

/** FR-RN1, FR-RN5 — renew a domain for the years chosen, paid on Flutterwave. */
export default function RenewPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<PanelSkeleton />}>
      <Renew params={params} />
    </Suspense>
  )
}
