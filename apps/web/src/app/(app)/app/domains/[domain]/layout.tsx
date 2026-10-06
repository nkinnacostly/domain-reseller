import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { DomainName, domainLabel } from '@/components/common/domain-name'
import { DomainStatusPill } from '@/components/common/domain-status-pill'
import { PanelHeader, PanelPage, PanelPageSkeleton } from '@/components/layout/panel'
import { DomainBadges } from '@/features/domains/components/domain-badges'
import { DomainTabs } from '@/features/domains/components/domain-tabs'
import { RegistryHoldNotice } from '@/features/domains/components/registry-hold-notice'
import { daysUntilExpiry } from '@/features/domains/lib/portfolio'
import { getDomain } from '@/features/domains/queries/domains'

type Params = Promise<{ domain: string }>

async function DomainHeader({ params }: { params: Params }) {
  const { domain: name } = await params
  const domain = await getDomain(name)
  if (!domain) notFound()
  const days = daysUntilExpiry(domain.expiresAt, new Date())

  return (
    <>
      <PanelHeader
        crumbs={[
          { label: 'Home', href: '/' },
          { label: 'Dashboard', href: '/app/domains' },
          { label: domainLabel(domain.domainName) },
        ]}
        title={
          <span className="break-all">
            <DomainName name={domain.domainName} />
          </span>
        }
        titleAside={
          <>
            <DomainStatusPill
              status={domain.status}
              daysUntilExpiry={days ?? undefined}
              onHold={domain.onHold}
            />
            <DomainBadges source={domain.source} testMode={domain.testMode} />
          </>
        }
      >
        <DomainTabs domain={domain.domainName} />
      </PanelHeader>
      {domain.onHold ? <RegistryHoldNotice domainName={domain.domainName} /> : null}
    </>
  )
}

/** FR-P6 — the domain, with its tabs. Each tab is a page, so the URL says where you are. */
export default function DomainLayout({
  params,
  children,
}: {
  params: Params
  children: React.ReactNode
}) {
  return (
    <PanelPage>
      <Suspense fallback={<PanelPageSkeleton height="h-64" />}>
        <DomainHeader params={params} />
      </Suspense>
      {children}
    </PanelPage>
  )
}
