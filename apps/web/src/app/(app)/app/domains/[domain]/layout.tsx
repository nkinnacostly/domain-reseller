import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { DomainStatusPill } from '@/components/common/domain-status-pill'
import { Container } from '@/components/layout/site-shell'
import { DomainBadges } from '@/features/domains/components/domain-badges'
import { DomainTabs } from '@/features/domains/components/domain-tabs'
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
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight break-all sm:text-3xl">
          {domain.domainName}
        </h1>
        <DomainStatusPill status={domain.status} daysUntilExpiry={days ?? undefined} />
        <DomainBadges source={domain.source} testMode={domain.testMode} />
      </div>
      <div className="mt-6">
        <DomainTabs domain={domain.domainName} />
      </div>
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
    <Container className="py-10 sm:py-14">
      <Suspense
        fallback={<div aria-hidden="true" className="h-24 animate-pulse rounded-2xl bg-muted" />}
      >
        <DomainHeader params={params} />
      </Suspense>
      <div className="mt-8">{children}</div>
    </Container>
  )
}
