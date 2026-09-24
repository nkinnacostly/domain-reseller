import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { PANEL_HEADING, Panel, PanelSkeleton } from '@/components/layout/panel'
import { PanelNote } from '@/features/domains/components/domain-badges'
import { getDomain } from '@/features/domains/queries/domains'

export const metadata: Metadata = { title: 'Security' }
type Params = Promise<{ domain: string }>

async function Security({ params }: { params: Params }) {
  const { domain: name } = await params
  const domain = await getDomain(name)
  if (!domain) notFound()

  const rows = [
    {
      title: 'Transfer lock',
      state: domain.transferLock ? 'On' : 'Off',
      body: 'Stops anyone moving this domain to another registrar. It is on from registration.',
    },
    {
      title: 'Transfer code',
      state: 'Hidden',
      body: 'The code another registrar asks for when you move a domain away. ICANN rules require us to give it to you within five days of asking.',
    },
    {
      title: 'Contact privacy',
      state: domain.privacyEnabled ? 'On' : 'Off',
      body: 'Keeps your name, email and phone out of public lookups. Free, on generic extensions.',
    },
  ]

  return (
    <Panel labelledBy="security-heading">
      <h2 id="security-heading" className={PANEL_HEADING}>
        Security
      </h2>
      <ul aria-label="Security settings" className="mt-4 grid gap-2 xl:grid-cols-3">
        {rows.map((row) => (
          <li
            key={row.title}
            className="rounded-2xl border border-border bg-background/80 px-5 py-4"
          >
            <div className="flex items-center justify-between gap-4">
              <h3 className="font-medium text-foreground">{row.title}</h3>
              <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-foreground">
                {row.state}
              </span>
            </div>
            <p className="mt-1.5 text-pretty text-sm/6 text-muted-foreground">{row.body}</p>
          </li>
        ))}
      </ul>
      <div className="mt-5 max-w-2xl">
        <PanelNote title="Not editable here yet.">
          Changing the lock, privacy or transfer code from here is not built yet.
        </PanelNote>
      </div>
    </Panel>
  )
}

export default function SecurityPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<PanelSkeleton />}>
      <Security params={params} />
    </Suspense>
  )
}
