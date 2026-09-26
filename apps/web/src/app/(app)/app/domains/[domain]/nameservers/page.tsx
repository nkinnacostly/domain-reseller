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
import { NameserverHistory } from '@/features/domains/components/nameserver-history'
import { RevertNameservers } from '@/features/domains/components/revert-nameservers'
import { revertTarget } from '@/features/domains/lib/nameserver-history'
import { type RegistrarSide, registrarSide } from '@/features/domains/lib/registrar-default'
import { nameserverNote } from '@/features/domains/lib/registration'
import {
  getDomain,
  getNameserverHistory,
  getNameserverPresets,
  getRegistrarDefault,
} from '@/features/domains/queries/domains'

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

  const revertTo = revertTarget(domain)
  const hasTwoFactor = Boolean(account?.totpFactor)

  return (
    <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
      <div className="space-y-4">
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
                currentPresetId={domain.presetId}
                presets={presets}
                side={registrarSide(domain)}
                hasTwoFactor={hasTwoFactor}
              />
            </Suspense>
          </div>
        </Panel>

        {/* FR-N5 — before and after for every change, and one click back. */}
        <Panel labelledBy="history-heading" className="h-fit">
          <h2 id="history-heading" className={PANEL_HEADING}>
            Change history
          </h2>
          <p className="mt-1.5 text-pretty text-sm/6 text-muted-foreground">
            Every change to {domain.domainName}’s nameservers, newest first.
          </p>
          {revertTo ? (
            <div className="mt-4">
              <RevertNameservers
                domainId={domain.id}
                domain={domain.domainName}
                previous={revertTo.nameservers}
                waiting={revertTo.waiting}
                hasTwoFactor={hasTwoFactor}
              />
            </div>
          ) : null}
          <div className="mt-4">
            <Suspense fallback={<DnsSkeleton rows={2} />}>
              <History domainId={domain.id} />
            </Suspense>
          </div>
        </Panel>
      </div>

      <div className="space-y-4">
        <Panel labelledBy="resolvers-heading">
          <h2 id="resolvers-heading" className={PANEL_HEADING}>
            What the internet sees
          </h2>
          <p className="mt-1.5 text-pretty text-sm/6 text-muted-foreground">
            Checked live with three public resolvers. After a change, each usually catches up within
            a few hours as its cached answer expires; some keep the old answer for up to 48 hours.
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

async function History({ domainId }: { domainId: string }) {
  const entries = await getNameserverHistory(domainId)
  if (!entries) {
    return (
      <p className="text-sm text-foreground">
        The history couldn’t be loaded just now. Reload the page to try again.
      </p>
    )
  }
  return <NameserverHistory entries={entries} />
}

/** The live records (FR-N6) and the side's registrar default (migration 35), read together. */
async function NameserverFormWithRecords({
  side,
  ...props
}: Omit<Parameters<typeof NameserverForm>[0], 'currentRecords' | 'registrarDefault'> & {
  side: RegistrarSide
}) {
  const [currentRecords, registrarDefault] = await Promise.all([
    currentRecordSummary(props.domain),
    getRegistrarDefault(side),
  ])
  return (
    <NameserverForm
      {...props}
      currentRecords={currentRecords}
      registrarDefault={registrarDefault}
    />
  )
}

export default function NameserversPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<PanelSkeleton height="h-96" />}>
      <Nameservers params={params} />
    </Suspense>
  )
}
