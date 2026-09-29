import { formatNaira, formatRenewal } from '@dr/shared'
import { ArrowLeft } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import { DomainName } from '@/components/common/domain-name'
import { FormMessage } from '@/components/common/form-parts'
import {
  FOCUS,
  PANEL_HEADING,
  Panel,
  PanelHeader,
  PanelPage,
  PanelPageSkeleton,
} from '@/components/layout/panel'
import {
  type BulkRenewalDomain,
  type BulkRenewalOption,
  BulkRenewForm,
} from '@/features/renewals/components/bulk-renew-form'
import {
  addYears,
  BULK_RENEW_MAX,
  bulkRenewalTotals,
  parseRenewIds,
  priceRise,
  sharedYears,
} from '@/features/renewals/lib/renewal'
import {
  type BulkRenewalLine,
  type BulkRenewalView,
  getBulkRenewalView,
} from '@/features/renewals/queries/renewal'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Renew domains' }

type Search = Promise<{ ids?: string }>

const dateFormat = new Intl.DateTimeFormat('en-NG', { dateStyle: 'long', timeZone: 'Africa/Lagos' })

const CRUMBS = [
  { label: 'Home', href: '/' },
  { label: 'Dashboard', href: '/app/domains' },
  { label: 'Renew' },
]

function BackLink() {
  return (
    <Link
      href="/app/domains#portfolio"
      className={cn(
        'inline-flex h-11 items-center gap-2 rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition hover:bg-brand-subtle active:scale-[0.98]',
        FOCUS,
      )}
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      Back to your domains
    </Link>
  )
}

function Unavailable({ title, message }: { title: string; message: string }) {
  return (
    <>
      <PanelHeader crumbs={CRUMBS} title={title} />
      <Panel labelledBy="renew-unavailable-heading" className="max-w-2xl">
        <h2 id="renew-unavailable-heading" className={PANEL_HEADING}>
          Nothing to renew here
        </h2>
        <p className="mt-2 text-pretty text-sm/6 text-foreground">{message}</p>
        <div className="mt-5">
          <BackLink />
        </div>
      </Panel>
    </>
  )
}

type Renewable = BulkRenewalLine & {
  check: { ok: true; maxYears: number; years: number[] }
  pricing: NonNullable<BulkRenewalLine['pricing']>
  expiresAt: string
}

const isRenewable = (line: BulkRenewalLine): line is Renewable =>
  line.check.ok && line.pricing !== null && line.expiresAt !== null

/** Each choice of years, priced line by line as the one-domain renewal prices it. */
function priceOptions(lines: Renewable[], choices: number[], vatPct: number): BulkRenewalOption[] {
  return choices.map((years) => {
    const totals = bulkRenewalTotals(
      lines.map((line) => line.pricing),
      years,
      vatPct,
    )
    return {
      years,
      subtotal: formatNaira(totals.subtotalKobo),
      vat: formatNaira(totals.vatKobo),
      total: formatNaira(totals.totalKobo),
      totalKobo: totals.totalKobo,
      lines: Object.fromEntries(
        lines.map((line, position) => [
          line.id,
          {
            newExpiry: dateFormat.format(addYears(line.expiresAt, years)),
            price: formatNaira(totals.lineKobo[position] ?? 0),
          },
        ]),
      ),
    }
  })
}

async function Renew({ searchParams }: { searchParams: Search }) {
  const ids = parseRenewIds((await searchParams).ids)
  if (ids.length === 0) {
    return (
      <Unavailable
        title="Renew domains"
        message="No domains were chosen. Tick the ones to renew in your domains list, then choose Renew."
      />
    )
  }
  if (ids.length > BULK_RENEW_MAX) {
    return (
      <Unavailable
        title="Renew domains"
        message={`Up to ${BULK_RENEW_MAX} domains can be renewed in one order. Choose fewer, then try again.`}
      />
    )
  }

  let view: BulkRenewalView
  try {
    view = await getBulkRenewalView(ids)
  } catch {
    return (
      <>
        <PanelHeader crumbs={CRUMBS} title="Renew domains" />
        <FormMessage tone="error">
          Your domains couldn’t be loaded just now. Nothing has been charged.{' '}
          <a
            href={`/app/domains/renew?ids=${ids.join(',')}`}
            className="font-medium underline underline-offset-2"
          >
            Try again
          </a>
        </FormMessage>
      </>
    )
  }

  const renewable = view.lines.filter(isRenewable)
  const skipped = view.lines.filter((line) => !isRenewable(line))
  // The same years for every domain: only periods each one's registry renews in (FR-P4).
  const choices = sharedYears(renewable.map((line) => line.check))
  const title =
    renewable.length === 0
      ? 'Renew domains'
      : `Renew ${renewable.length} ${renewable.length === 1 ? 'domain' : 'domains'}`

  if (view.lines.length === 0) {
    return (
      <Unavailable title={title} message="None of those domains are on your account any more." />
    )
  }
  if (!view.open) {
    return (
      <Unavailable
        title={title}
        message="Payments aren’t open yet, so renewals are paused. Nothing has been charged."
      />
    )
  }

  const domains: BulkRenewalDomain[] = renewable.map((line) => {
    const rise = priceRise(line.previousRenewalKobo, line.pricing.renewal.priceKobo)
    const term = line.pricing.renewalTerm.years
    return {
      id: line.id,
      domainName: line.domainName,
      expires: dateFormat.format(new Date(line.expiresAt)),
      renewal: formatRenewal(line.pricing.renewal.priceKobo, term),
      priceRise: rise
        ? { from: formatRenewal(rise.from, term), to: formatRenewal(rise.to, term) }
        : null,
    }
  })

  return (
    <>
      <PanelHeader
        crumbs={CRUMBS}
        title={title}
        description="One order and one payment. Each domain’s years are added to its own expiry date, so renewing early loses nothing."
      />
      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <Panel labelledBy="renew-heading" className="h-fit">
          <h2 id="renew-heading" className={PANEL_HEADING}>
            Your renewal
          </h2>
          <div className="mt-4">
            {renewable.length > 0 && choices && choices.length > 0 ? (
              <BulkRenewForm
                domains={domains}
                options={priceOptions(renewable, choices, view.vatPct)}
                vatPct={view.vatPct}
                testMode={view.paymentTestMode === true}
              />
            ) : renewable.length > 1 && choices?.length === 0 ? (
              <div className="space-y-4">
                <p className="text-pretty text-sm/6 text-foreground">
                  These domains can’t be renewed for the same number of years: their registries
                  renew them in different periods, or one is too close to the ten-year limit. Renew
                  them in separate orders from each domain’s page.
                </p>
                <BackLink />
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-pretty text-sm/6 text-foreground">
                  None of the domains chosen can be renewed now — each one below says why.
                </p>
                <BackLink />
              </div>
            )}
          </div>
        </Panel>

        <div className="space-y-4">
          {skipped.length > 0 ? (
            <Panel labelledBy="skipped-heading" className="h-fit">
              <h2 id="skipped-heading" className={PANEL_HEADING}>
                Not in this order
              </h2>
              <ul aria-label="Not in this order" className="mt-3 space-y-2 text-sm">
                {skipped.map((line) => (
                  <li
                    key={line.id}
                    data-skipped={line.domainName}
                    className="rounded-2xl border border-border bg-background/80 px-4 py-3"
                  >
                    <p className="font-medium break-all text-foreground">
                      <DomainName name={line.domainName} />
                    </p>
                    <p className="mt-0.5 text-pretty text-muted-foreground">
                      {line.check.ok
                        ? 'Renewal prices for this extension are unavailable right now.'
                        : line.check.reason}
                    </p>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
          <Panel labelledBy="how-heading" className="h-fit">
            <h2 id="how-heading" className={PANEL_HEADING}>
              How renewing works
            </h2>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-pretty text-sm/6 text-muted-foreground">
              <li>
                A registry holds a domain at most ten years ahead, so no choice goes past that.
              </li>
              <li>
                We read each new expiry back from the registry before we call it done. Progress
                shows on your order page, line by line, and in each domain’s activity.
              </li>
            </ul>
          </Panel>
        </div>
      </div>
    </>
  )
}

/** FR-P4, FR-P5 — renew the domains ticked in the portfolio, in one order. */
export default function BulkRenewPage({ searchParams }: { searchParams: Search }) {
  return (
    <PanelPage>
      <Suspense fallback={<PanelPageSkeleton />}>
        <Renew searchParams={searchParams} />
      </Suspense>
    </PanelPage>
  )
}
