import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { PANEL_HEADING, Panel, PanelSkeleton } from '@/components/layout/panel'
import { getAccount } from '@/features/auth/queries/account'
import {
  currentRecordSummary,
  DnsRecords,
  DnsSkeleton,
  ResolverViews,
} from '@/features/domains/components/dns-sections'
import { PanelNote } from '@/features/domains/components/domain-badges'
import { NameserverForm } from '@/features/domains/components/nameserver-form'
import { nameserverNote } from '@/features/domains/lib/registration'
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
  const note = nameserverNote(domain)

  return (
    <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
      <Panel labelledBy="change-heading" className="h-fit">
        <h2 id="change-heading" className={PANEL_HEADING}>
          Point it at your host
        </h2>
        <p className="mt-1.5 text-pretty text-sm/6 text-muted-foreground">
          Your host gives you two or more nameservers. Put them here and your host takes over the
          website and email for {domain.domainName}.
        </p>
        {note ? (
          <div className="mt-4">
            <PanelNote title={note.title}>{note.body}</PanelNote>
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
      </Panel>

      <div className="space-y-4">
        <Panel labelledBy="resolvers-heading">
          <h2 id="resolvers-heading" className={PANEL_HEADING}>
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
        </Panel>

        <Panel labelledBy="records-heading">
          <h2 id="records-heading" className={PANEL_HEADING}>
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
        </Panel>
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
    <Suspense fallback={<PanelSkeleton height="h-96" />}>
      <Nameservers params={params} />
    </Suspense>
  )
}
