import { formatRenewal } from '@dr/shared'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { FOCUS, PANEL, PANEL_HEADING, PanelSkeleton } from '@/components/layout/panel'
import { AutoRenewToggle } from '@/features/domains/components/auto-renew-toggle'
import { PanelNote } from '@/features/domains/components/domain-badges'
import { DomainLabels } from '@/features/domains/components/domain-labels'
import { DELEGATION_LABEL, daysUntilExpiry } from '@/features/domains/lib/portfolio'
import { isTransferInProgress, registrationNote } from '@/features/domains/lib/registration'
import { getDomain } from '@/features/domains/queries/domains'
import { getLabels } from '@/features/domains/queries/labels'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Domain' }

type Params = Promise<{ domain: string }>
const dateFormat = new Intl.DateTimeFormat('en-NG', { dateStyle: 'long', timeZone: 'Africa/Lagos' })

async function Overview({ params }: { params: Params }) {
  const { domain: name } = await params
  const [domain, priced, labels] = await Promise.all([
    getDomain(name),
    getPricedCatalogue(),
    getLabels(),
  ])
  if (!domain) notFound()

  const days = daysUntilExpiry(domain.expiresAt, new Date())
  const pricing = priced?.tlds.find((tld) => tld.tld === domain.tld)
  // N8 — with its term: "/yr", or "every 2 years" where the registry renews only in blocks.
  const renewal = pricing
    ? formatRenewal(pricing.renewal.priceKobo, pricing.renewalTerm.years)
    : null
  const note = registrationNote(domain)
  // Its dates and nameservers are the current registrar's until it lands (FR-T3).
  const moving = isTransferInProgress(domain.status)

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
              {domain.registeredAt
                ? dateFormat.format(new Date(domain.registeredAt))
                : moving
                  ? 'When the transfer completes'
                  : 'Not yet'}
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
              ) : moving ? (
                'Read from the registry when the transfer completes'
              ) : (
                'A year after registration'
              )}
            </dd>
          </div>
          {/* N8 — the renewal price, always. */}
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Renews at</dt>
            <dd className="text-right font-medium">{renewal ?? 'Price unavailable'}</dd>
          </div>
        </dl>
        {domain.source !== 'demo' &&
        (domain.status === 'active' || domain.status === 'expired_grace') ? (
          <Link
            href={`/app/domains/${domain.domainName}/renew`}
            className={cn(
              'mt-5 inline-flex h-10 items-center rounded-full bg-accent px-5 text-sm font-medium text-accent-foreground transition hover:bg-accent/90 active:scale-[0.98]',
              FOCUS,
            )}
          >
            Renew now
          </Link>
        ) : null}
        <div className="mt-5 border-border border-t pt-5">
          <AutoRenewToggle domainId={domain.id} autoRenew={domain.autoRenew} renewal={renewal} />
        </div>
      </section>

      <section aria-labelledby="pointing-heading" className={cn(PANEL, 'p-5 sm:p-6')}>
        <h2 id="pointing-heading" className={PANEL_HEADING}>
          Where it points
        </h2>
        {moving ? (
          <p className="mt-3 text-sm text-foreground">
            It keeps the nameservers it has now while it transfers. You can change them here once
            the transfer completes.
          </p>
        ) : (domain.pendingNameservers ?? domain.nameservers)?.length ? (
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

      {/* FR-P3 — the account's own labels, several to a domain. */}
      <section aria-labelledby="labels-heading" className={cn(PANEL, 'p-5 sm:p-6 xl:col-span-2')}>
        <h2 id="labels-heading" className={PANEL_HEADING}>
          Labels
        </h2>
        <div className="mt-3">
          {labels ? (
            <DomainLabels
              domainId={domain.id}
              domainName={domain.domainName}
              assigned={domain.labels}
              labels={labels}
            />
          ) : (
            <p className="text-sm text-foreground">
              Your labels couldn’t be loaded just now. Reload the page to try again.
            </p>
          )}
        </div>
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
