import { formatNaira } from '@dr/shared'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { FOCUS, PANEL, PANEL_HEADING, PanelSkeleton } from '@/components/layout/panel'
import { AutoRenewToggle } from '@/features/domains/components/auto-renew-toggle'
import { PanelNote } from '@/features/domains/components/domain-badges'
import { DELEGATION_LABEL, daysUntilExpiry } from '@/features/domains/lib/portfolio'
import { registrationNote } from '@/features/domains/lib/registration'
import { getDomain } from '@/features/domains/queries/domains'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Domain' }

type Params = Promise<{ domain: string }>
const dateFormat = new Intl.DateTimeFormat('en-NG', { dateStyle: 'long', timeZone: 'Africa/Lagos' })

async function Overview({ params }: { params: Params }) {
  const { domain: name } = await params
  const [domain, priced] = await Promise.all([getDomain(name), getPricedCatalogue()])
  if (!domain) notFound()

  const days = daysUntilExpiry(domain.expiresAt, new Date())
  const pricing = priced?.tlds.find((tld) => tld.tld === domain.tld)
  const renewal = pricing ? formatNaira(pricing.renewal.priceKobo) : null
  const note = registrationNote(domain)

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {note ? (
        <div className="xl:col-span-2">
          <PanelNote title={note.title}>{note.body}</PanelNote>
        </div>
      ) : null}

      <section aria-labelledby="dates-heading" className={cn(PANEL, 'p-5 sm:p-6')}>
        <h2 id="dates-heading" className={PANEL_HEADING}>
          Registration
        </h2>
        <dl className="mt-4 space-y-3 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Registered</dt>
            <dd className="text-right">
              {domain.registeredAt ? dateFormat.format(new Date(domain.registeredAt)) : 'Not yet'}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Expires</dt>
            <dd className="text-right">
              {domain.expiresAt ? (
                <>
                  {dateFormat.format(new Date(domain.expiresAt))}
                  <span className="block text-xs text-muted-foreground">
                    {days !== null && days < 0 ? `${-days} days ago` : `in ${days} days`}
                  </span>
                </>
              ) : (
                'A year after registration'
              )}
            </dd>
          </div>
          {/* N8 — the renewal price, always. */}
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Renews at</dt>
            <dd className="text-right font-medium">
              {renewal ? `${renewal}/yr` : 'Price unavailable'}
            </dd>
          </div>
        </dl>
        <div className="mt-5 border-border border-t pt-5">
          <AutoRenewToggle domainId={domain.id} autoRenew={domain.autoRenew} renewal={renewal} />
        </div>
      </section>

      <section aria-labelledby="pointing-heading" className={cn(PANEL, 'p-5 sm:p-6')}>
        <h2 id="pointing-heading" className={PANEL_HEADING}>
          Where it points
        </h2>
        {(domain.pendingNameservers ?? domain.nameservers)?.length ? (
          <>
            <p className="mt-3 text-sm text-muted-foreground">
              {domain.pendingNameservers
                ? 'A change is waiting to be applied.'
                : DELEGATION_LABEL[domain.delegationStatus]}
            </p>
            <p className="mt-2 font-mono text-xs break-all text-foreground">
              {(domain.pendingNameservers ?? domain.nameservers ?? []).join(', ')}
            </p>
          </>
        ) : (
          // FR-D7 — never a blank: say what to do next.
          <p className="mt-3 text-sm text-foreground">
            Not pointed at your host yet — where is your site hosted?
          </p>
        )}
        <Link
          href={`/app/domains/${domain.domainName}/nameservers`}
          className={cn(
            'mt-5 inline-flex h-10 items-center rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition hover:bg-brand-subtle active:scale-[0.98]',
            FOCUS,
          )}
        >
          Manage nameservers
        </Link>
      </section>
    </div>
  )
}

export default function DomainOverviewPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<PanelSkeleton />}>
      <Overview params={params} />
    </Suspense>
  )
}
