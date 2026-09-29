import { formatNaira, formatRenewal } from '@dr/shared'
import { ArrowRight, ArrowUpRight } from 'lucide-react'
import Link from 'next/link'
import { Container } from '@/components/layout/site-shell'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { searchHref } from '@/features/search/lib/query'
import {
  type ExtensionOffer,
  evaluateTransfer,
  formatDate,
  type TransferVerdict,
} from '../lib/eligibility'
import { parseTransferQuery, TRANSFER_QUERY_MESSAGES, transferStartHref } from '../lib/href'
import { canStartTransfer } from '../lib/start'
import { lookupDomain } from '../queries/rdap-lookup'
import { takesTransfersFor } from '../queries/transfer-offer'
import { TransferChecklist } from './transfer-checklist'

type Offer = { transfer: string; renewal: string }

/** Its own band between the hero and the guide, ruled off so it reads as the answer. */
function ResultBand({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <Container className="pt-12 sm:pt-16">{children}</Container>
    </div>
  )
}

function headline(verdict: TransferVerdict): { title: string; summary: string } {
  const { domain, tld } = verdict
  switch (verdict.outcome) {
    case 'ready':
      return {
        title: `${domain} is ready to transfer`,
        summary:
          'Everything the registry shows is in order. The one thing left is the auth code from your current registrar.',
      }
    case 'blocked':
      return verdict.opensOn
        ? {
            title: `${domain} can move from ${formatDate(verdict.opensOn)}`,
            summary: 'Only a waiting period is in the way. Nothing needs doing until then.',
          }
        : {
            title: `${domain} can't be transferred yet`,
            summary: 'Something below needs sorting first. Each item says exactly what.',
          }
    case 'needs-confirmation':
      return {
        title: `We couldn't check everything for ${domain}`,
        summary:
          'Confirm the items marked "Check yourself" with your current registrar before you start.',
      }
    case 'not-registered':
      return {
        title: `${domain} isn't registered`,
        summary: 'There is nothing to transfer — but it means the name is there for the taking.',
      }
    case 'unsupported-extension':
      return {
        title: `We don't take transfers for .${tld} yet`,
        summary: 'The pricing page lists every extension we can bring in.',
      }
  }
}

/**
 * The result of a transfer check (PRD FR-T1). Reads `?domain=`, so it sits
 * inside the page's Suspense boundary — request-time data under Cache
 * Components.
 */
export async function TransferResult({
  searchParams,
}: {
  searchParams: Promise<{ domain?: string | string[] }>
}) {
  const { domain: raw } = await searchParams
  const input = Array.isArray(raw) ? raw[0] : raw
  // No domain asked about yet: the page is just the explainer.
  if (!input?.trim()) return null

  const query = parseTransferQuery(input)

  if (!query.ok) {
    return (
      <ResultBand>
        <section id="check" aria-labelledby="check-heading" className="scroll-mt-8">
          <h2 id="check-heading" className="text-xl font-bold tracking-tight sm:text-2xl">
            That doesn't look like a domain
          </h2>
          <p className="mt-2 text-muted-foreground">{TRANSFER_QUERY_MESSAGES[query.reason]}.</p>
        </section>
      </ResultBand>
    )
  }

  const priced = await getPricedCatalogue()
  const entry = priced?.tlds.find((tld) => tld.tld === query.tld)
  const offer: Offer | null = entry?.transfer
    ? {
        transfer: formatNaira(entry.transfer.priceKobo),
        renewal: formatRenewal(entry.renewal.priceKobo, entry.renewalTerm.years),
      }
    : null
  const offered: ExtensionOffer = !priced ? 'unknown' : offer ? 'offered' : 'not-offered'

  // No point asking the registry about a domain we could not take anyway.
  const lookup = offered === 'not-offered' ? null : await lookupDomain(query.domain)
  const verdict = evaluateTransfer({
    domain: query.domain,
    tld: query.tld,
    offer: offered,
    lookup,
    now: new Date(),
  })
  const { title, summary } = headline(verdict)
  // The checkout's own gate (N5b): offered only once the catalogue says so.
  const startable = offer ? await takesTransfersFor(query.tld) : false

  return (
    <ResultBand>
      <section id="check" aria-labelledby="check-heading" className="scroll-mt-8">
        <div className="grid gap-10 lg:grid-cols-[1.6fr_1fr] lg:gap-16">
          <div className="min-w-0">
            <p className="text-sm font-medium text-muted-foreground">Transfer check</p>
            <h2
              id="check-heading"
              className="mt-2 text-2xl font-bold tracking-tight text-balance break-words sm:text-3xl"
            >
              {title}
            </h2>
            <p className="mt-3 max-w-xl text-pretty text-muted-foreground">{summary}</p>

            {verdict.outcome === 'not-registered' ? (
              <Link
                href={searchHref(query.domain)}
                className="mt-5 inline-flex h-11 items-center gap-2 rounded-full bg-accent px-6 text-sm font-medium text-accent-foreground transition hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
              >
                Search for {query.domain}
                <ArrowUpRight className="size-4" aria-hidden="true" />
              </Link>
            ) : null}

            {verdict.outcome === 'unsupported-extension' ? (
              <Link
                href="/pricing"
                className="mt-5 inline-flex h-11 items-center gap-2 rounded-full border border-border bg-background px-6 text-sm font-medium text-foreground transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
              >
                See every extension
                <ArrowUpRight className="size-4" aria-hidden="true" />
              </Link>
            ) : null}

            <div className="mt-8">
              <TransferChecklist checks={verdict.checks} />
            </div>

            <p className="mt-2 text-xs text-muted-foreground">
              Checked live at the registry just now. Nothing was charged, and nothing changed at
              your current registrar.
            </p>
          </div>

          {offer && verdict.outcome !== 'not-registered' ? (
            <aside
              aria-label={`Transfer price for .${query.tld}`}
              className="h-fit rounded-2xl border border-border bg-background p-6"
            >
              <p className="text-sm text-muted-foreground">Transfer price</p>
              <p className="mt-1 text-3xl font-bold tracking-tight text-foreground tabular-nums">
                {offer.transfer}
              </p>
              {/* N8 — never a price without its renewal price. */}
              <p className="mt-1 text-sm text-muted-foreground">
                Then renews at <span className="font-medium text-foreground">{offer.renewal}</span>
              </p>
              <p className="mt-4 text-pretty text-xs/5 text-muted-foreground">
                In naira, before VAT. Includes an extra year on your registration where the registry
                adds one.
              </p>

              {!startable ? (
                <div className="mt-6 rounded-xl bg-muted/60 p-4 text-pretty text-sm/6 text-muted-foreground">
                  <span className="font-medium text-foreground">
                    Starting a transfer for .{query.tld} isn't open yet.
                  </span>{' '}
                  The checks on this page are live, but a transfer of this extension can’t be paid
                  for here yet.
                </div>
              ) : canStartTransfer(verdict).ok ? (
                <>
                  <Link
                    href={transferStartHref(query.domain)}
                    className="mt-6 inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-accent px-6 text-sm font-medium text-accent-foreground transition hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
                  >
                    Transfer it to us
                    <ArrowRight className="size-4" aria-hidden="true" />
                  </Link>
                  <p className="mt-3 text-pretty text-xs/5 text-muted-foreground">
                    You’ll need the transfer code from your current registrar. We check it with the
                    registry before you pay.
                  </p>
                </>
              ) : (
                <div className="mt-6 rounded-xl bg-muted/60 p-4 text-pretty text-sm/6 text-muted-foreground">
                  <span className="font-medium text-foreground">
                    Clear the blocked items first.
                  </span>{' '}
                  Once they are sorted, check again here and you can start the transfer.
                </div>
              )}
            </aside>
          ) : null}
        </div>
      </section>
    </ResultBand>
  )
}
