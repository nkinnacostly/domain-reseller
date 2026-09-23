import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { getAccount } from '@/features/auth/queries/account'
import {
  currentRecordSummary,
  DnsRecords,
  DnsSkeleton,
  ResolverViews,
} from '@/features/domains/components/dns-sections'
import { NotConnectedNote } from '@/features/domains/components/domain-badges'
import { NameserverForm } from '@/features/domains/components/nameserver-form'
import { getDomain, getNameserverPresets } from '@/features/domains/queries/domains'

export const metadata: Metadata = { title: 'Nameservers' }
type Params = Promise<{ domain: string }>

async function Nameservers({ params }: { params: Params }) {
  const { domain: name } = await params
  const [domain, account, presets] = await Promise.all([
    getDomain(name),
    getAccount(),
    getNameserverPresets(),
  ])
  if (!domain) notFound()
  const requested = domain.pendingNameservers ?? domain.nameservers

  return (
    <div className="grid gap-10 lg:grid-cols-[1.2fr_1fr] lg:gap-14">
      <section aria-labelledby="change-heading">
        <h2 id="change-heading" className="text-lg font-semibold text-foreground">
          Point it at your host
        </h2>
        <p className="mt-1.5 text-pretty text-sm/6 text-muted-foreground">
          Your host gives you two or more nameservers. Put them here and your host takes over the
          website and email for {domain.domainName}.
        </p>
        {domain.pendingNameservers ? (
          <div className="mt-4">
            <NotConnectedNote>
              Waiting to be applied at the registry: {domain.pendingNameservers.join(', ')}.
            </NotConnectedNote>
          </div>
        ) : null}
        <div className="mt-6">
          <Suspense fallback={<DnsSkeleton rows={4} />}>
            <NameserverFormWithRecords
              domainId={domain.id}
              domain={domain.domainName}
              current={requested}
              presets={presets}
              hasTwoFactor={Boolean(account?.totpFactor)}
            />
          </Suspense>
        </div>
      </section>

      <div className="space-y-10">
        <section aria-labelledby="resolvers-heading">
          <h2 id="resolvers-heading" className="text-lg font-semibold text-foreground">
            What the internet sees
          </h2>
          <p className="mt-1.5 text-pretty text-sm/6 text-muted-foreground">
            Checked live with three public resolvers. After a change, each catches up within a few
            hours as its cached answer expires.
          </p>
          <div className="mt-4">
            <Suspense fallback={<DnsSkeleton />}>
              <ResolverViews domain={domain.domainName} expected={requested} />
            </Suspense>
          </div>
        </section>

        <section aria-labelledby="records-heading">
          <h2 id="records-heading" className="text-lg font-semibold text-foreground">
            DNS records
          </h2>
          <p className="mt-1.5 text-pretty text-sm/6 text-muted-foreground">
            Read-only — your host manages these. Useful when a website or email is not working.
          </p>
          <div className="mt-4">
            <Suspense fallback={<DnsSkeleton rows={6} />}>
              <DnsRecords domain={domain.domainName} />
            </Suspense>
          </div>
        </section>
      </div>
    </div>
  )
}

async function NameserverFormWithRecords(
  props: Omit<Parameters<typeof NameserverForm>[0], 'currentRecords'>,
) {
  const currentRecords = await currentRecordSummary(props.domain)
  return <NameserverForm {...props} currentRecords={currentRecords} />
}

export default function NameserversPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<DnsSkeleton rows={6} />}>
      <Nameservers params={params} />
    </Suspense>
  )
}
