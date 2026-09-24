import { ArrowUpRight, RotateCw } from 'lucide-react'
import { headers } from 'next/headers'
import Link from 'next/link'
import { Container } from '@/components/layout/site-shell'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { searchHref } from '@/features/search/lib/query'
import { clientKey } from '@/lib/client-ip'
import { LIMITS, withinLimit } from '@/lib/rate-limit'
import {
  formatCheckedAt,
  parseWhoisQuery,
  registeredHeadline,
  WHOIS_QUERY_MESSAGES,
  whoisHref,
} from '../lib/whois'
import { lookupWhois } from '../queries/whois'
import { WhoisRecordDetails } from './whois-record'

const PRIMARY =
  'inline-flex h-11 items-center gap-2 rounded-full bg-accent px-6 text-sm font-medium text-accent-foreground transition hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]'
const SECONDARY =
  'inline-flex h-11 items-center gap-2 rounded-full border border-border bg-background px-6 text-sm font-medium text-foreground transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]'

/** The answer's own band between the hero and the explainer, like the transfer check. */
function ResultBand({
  eyebrow = 'WHOIS lookup',
  title,
  summary,
  children,
}: {
  eyebrow?: string
  title: string
  summary: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <Container className="pt-12 sm:pt-16">
      <section id="result" aria-labelledby="result-heading" className="scroll-mt-8">
        <p className="text-sm font-medium text-muted-foreground">{eyebrow}</p>
        <h2
          id="result-heading"
          className="mt-2 text-2xl font-bold tracking-tight text-balance break-words sm:text-3xl"
        >
          {title}
        </h2>
        <div className="mt-3 max-w-2xl text-pretty text-muted-foreground">{summary}</div>
        {children}
      </section>
    </Container>
  )
}

/**
 * Counted before the lookup, per address and in total (FR-PUB2). Fails closed,
 * like every limit here: if the count cannot be read, no lookup is made.
 */
async function mayLookUp(): Promise<boolean> {
  try {
    const key = clientKey(await headers())
    return (
      (await withinLimit(`whois:${key}`, LIMITS.whoisLookup)) &&
      (await withinLimit('whois:all', LIMITS.whoisAll))
    )
  } catch {
    return false
  }
}

/**
 * The answer to a WHOIS lookup (PRD FR-PUB2). Reads `?domain=`, so it sits
 * inside the page's Suspense boundary — request-time data under Cache
 * Components. Nothing here logs the name looked up (FR-S7).
 */
export async function WhoisResult({
  searchParams,
}: {
  searchParams: Promise<{ domain?: string | string[] }>
}) {
  const { domain: raw } = await searchParams
  const input = Array.isArray(raw) ? raw[0] : raw
  // Nothing asked about yet: the page is just the explainer.
  if (!input?.trim()) return null

  const query = parseWhoisQuery(input)
  if (!query.ok) {
    return (
      <ResultBand
        title="That doesn't look like a domain"
        summary={<p>{WHOIS_QUERY_MESSAGES[query.reason]}.</p>}
      />
    )
  }

  if (!(await mayLookUp())) {
    return (
      <ResultBand
        title="Too many lookups just now"
        summary={
          <p>
            We can&apos;t take another lookup from you at the moment. Wait a few minutes, then try
            again.
          </p>
        }
      />
    )
  }

  const { domain, tld } = query
  const [{ lookup, checkedAt }, priced] = await Promise.all([
    lookupWhois(domain),
    getPricedCatalogue(),
  ])
  // Null: the price list could not be read, so we cannot say either way.
  const weSell = priced ? priced.tlds.some((entry) => entry.tld === tld) : null

  const checked = checkedAt ? (
    <p className="mt-8 text-xs text-muted-foreground">
      From the .{tld} registry&apos;s public record at {formatCheckedAt(checkedAt)}, Lagos time. We
      keep an answer for up to 15 minutes.
    </p>
  ) : null

  switch (lookup.kind) {
    case 'found': {
      const { title, summary } = registeredHeadline(domain, lookup.record, new Date())
      return (
        <ResultBand title={title} summary={<p>{summary}</p>}>
          <div className="mt-8 rounded-[2rem] border border-border p-6 sm:p-8">
            <WhoisRecordDetails record={lookup.record} />
          </div>
          {checked}
        </ResultBand>
      )
    }

    case 'not-found':
      return (
        <ResultBand
          title={`${domain} isn't registered`}
          summary={
            weSell === false ? (
              <p>
                The registry has no record of it. We don&apos;t sell .{tld} domains, so it
                can&apos;t be registered here.
              </p>
            ) : (
              <p>
                The registry has no record of it, so it may be yours to register. Search to see
                whether it is available and what it costs.
              </p>
            )
          }
        >
          <div className="mt-5">
            {weSell === false ? (
              <Link href="/pricing" className={SECONDARY}>
                See the extensions we sell
                <ArrowUpRight className="size-4" aria-hidden="true" />
              </Link>
            ) : (
              <Link href={searchHref(domain)} className={PRIMARY}>
                Register {domain}
                <ArrowUpRight className="size-4" aria-hidden="true" />
              </Link>
            )}
          </div>
          {checked}
        </ResultBand>
      )

    case 'unsupported':
      return (
        <ResultBand
          title={`We can't look up .${tld} domains`}
          summary={
            <p>
              The .{tld} registry does not publish live registration records (RDAP), so there is
              nothing for us to ask.
              {weSell === false ? null : ' You can still check whether the name is available.'}
            </p>
          }
        >
          {weSell === false ? null : (
            <div className="mt-5">
              <Link href={searchHref(domain)} className={SECONDARY}>
                Check {domain}
                <ArrowUpRight className="size-4" aria-hidden="true" />
              </Link>
            </div>
          )}
        </ResultBand>
      )

    case 'unavailable':
      return (
        <ResultBand
          title="The registry didn't answer"
          summary={
            <p>
              We asked the .{tld} registry about {domain} but got no usable answer. Registries are
              sometimes slow or briefly down — try again in a minute.
            </p>
          }
        >
          <div className="mt-5">
            <Link href={whoisHref(domain)} className={SECONDARY}>
              <RotateCw className="size-4" aria-hidden="true" />
              Try again
            </Link>
          </div>
        </ResultBand>
      )
  }
}
