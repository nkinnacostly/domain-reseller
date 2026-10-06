import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { FormMessage } from '@/components/common/form-parts'
import { Container } from '@/components/layout/container'
import { PartError } from '@/features/accounts/components/overview-parts'
import { getCurrentAccount } from '@/features/accounts/queries/accounts'
import { env } from '@/lib/env'
import { domainRecords } from '../lib/records'
import { domainPhase, failureWords, formatWhen, PHASE_WORDS } from '../lib/status'
import { type Domain, getDomain } from '../queries/domains'
import { CheckNowButton, RemoveDomainButton, RetryButton } from './domain-actions'
import { DomainStatusPill } from './domain-status'
import { HostGuides } from './host-guides'
import { LiveRecords } from './live-records'
import { RecordsTable } from './records-table'

const card = 'rounded-3xl border border-border bg-card p-5 sm:p-6'
const MANAGERS = new Set(['owner', 'admin', 'developer'])

/**
 * One domain (MAIL-SPEC §5, §10): its state in words, the records to add with
 * copy buttons and what public DNS says of each (live, in Suspense), "Check
 * now", where to add the records at the common hosts, and removing it.
 */
export async function DomainPage({ params }: { params: Promise<{ id: string }> }) {
  const [data, { id }] = await Promise.all([getCurrentAccount(), params])
  if (!data) return null
  const { account, role } = data.current
  let domain: Domain | null
  try {
    domain = await getDomain(account.id, id)
  } catch {
    return (
      <Container className="py-6 sm:py-8">
        <PartError what="this domain" retryHref={`/dashboard/domains/${id}`} />
      </Container>
    )
  }
  if (!domain) notFound()

  const canManage = MANAGERS.has(role)
  const phase = domainPhase(domain.status, domain.settingUp)
  const records =
    domain.status === 'failed' || domain.dkimTokens.length === 0
      ? []
      : domainRecords({
          name: domain.name,
          dkimTokens: domain.dkimTokens,
          mailFromDomain: domain.mailFromDomain,
          region: env.MAIL_SES_REGION ?? 'eu-west-2',
        })
  const facts: [string, string][] = [
    ['Added', formatWhen(domain.createdAt) ?? '—'],
    ...(domain.verifiedAt
      ? [['Verified', formatWhen(domain.verifiedAt) ?? '—'] as [string, string]]
      : []),
    ...(domain.status === 'pending' && domain.deadline
      ? [['To verify by', formatWhen(domain.deadline) ?? '—'] as [string, string]]
      : []),
    ['Last checked', formatWhen(domain.lastCheckedAt) ?? 'Not yet'],
  ]

  return (
    <Container className="space-y-6 py-6 sm:py-8">
      <Link
        href="/dashboard/domains"
        className="inline-flex min-h-11 items-center gap-2 rounded-full text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        All domains
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight break-all sm:text-3xl">
            {domain.unicode ?? domain.name}
          </h1>
          {domain.unicode ? (
            <p className="mt-1 text-sm break-all text-muted-foreground">{domain.name}</p>
          ) : null}
        </div>
        <DomainStatusPill status={domain.status} settingUp={domain.settingUp} />
      </div>

      <section aria-labelledby="state-heading" className={card}>
        <h2 id="state-heading" className="sr-only">
          State
        </h2>
        {domain.status === 'failed' ? (
          <FormMessage tone="error">
            <p className="font-medium">Not verified</p>
            <p>{failureWords(domain.failedReason, domain.missingRecord)}</p>
          </FormMessage>
        ) : phase ? (
          <p className="text-pretty text-sm/6">{PHASE_WORDS[phase]}</p>
        ) : null}
        <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="mt-0.5 font-medium">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-5 flex flex-wrap items-start gap-3">
          {domain.status === 'pending' || domain.status === 'verified' ? (
            <CheckNowButton accountId={account.id} domainId={domain.id} />
          ) : null}
          {domain.status === 'failed' && canManage && domain.released ? (
            <RetryButton accountId={account.id} domainId={domain.id} />
          ) : null}
        </div>
      </section>

      {records.length > 0 ? (
        <section aria-labelledby="records-heading" className="space-y-3">
          <div>
            <h2 id="records-heading" className="font-semibold">
              DNS records
            </h2>
            <p className="mt-1 text-pretty text-sm text-muted-foreground">
              Add these at the host that runs your domain’s DNS. We check public DNS each time this
              page loads; Amazon SES checks for 72 hours from when the domain was added.
            </p>
          </div>
          <Suspense
            fallback={<RecordsTable records={records} zone={domain.name} live="checking" />}
          >
            <LiveRecords records={records} zone={domain.name} />
          </Suspense>
        </section>
      ) : domain.status === 'pending' ? (
        <p className="rounded-2xl border border-dashed border-border px-4 py-5 text-pretty text-sm/6 text-muted-foreground">
          The DNS records appear here as soon as Amazon SES gives them. Refresh in a moment.
        </p>
      ) : null}

      {records.length > 0 ? (
        <section aria-labelledby="hosts-heading" className="space-y-3">
          <h2 id="hosts-heading" className="font-semibold">
            Where to add them
          </h2>
          <HostGuides />
        </section>
      ) : null}

      {canManage && domain.status !== 'removing' ? (
        <section aria-labelledby="remove-heading" className={card}>
          <h2 id="remove-heading" className="font-semibold">
            Remove this domain
          </h2>
          <p className="mt-1 mb-4 text-pretty text-sm text-muted-foreground">
            Not while emails from it are waiting to be sent.
          </p>
          <RemoveDomainButton
            accountId={account.id}
            domainId={domain.id}
            name={domain.unicode ?? domain.name}
          />
        </section>
      ) : null}
    </Container>
  )
}
