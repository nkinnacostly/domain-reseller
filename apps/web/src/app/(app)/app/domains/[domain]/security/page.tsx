import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { NotConnectedNote } from '@/features/domains/components/domain-badges'
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
      body: 'Stops anyone moving this domain to another registrar. Turning it off needs a two-factor code and is for when you are transferring away.',
    },
    {
      title: 'Transfer code',
      state: 'Hidden',
      body: 'The code another registrar asks for. Revealing it needs a two-factor code, is logged, and emails you — we release it within five days of asking, always.',
    },
    {
      title: 'Contact privacy',
      state: domain.privacyEnabled ? 'On' : 'Off',
      body: 'Keeps your name, email and phone out of public lookups. Free, on generic extensions.',
    },
  ]

  return (
    <div className="max-w-2xl space-y-6">
      <ul
        aria-label="Security settings"
        className="divide-y divide-border/70 rounded-2xl border border-border"
      >
        {rows.map((row) => (
          <li key={row.title} className="px-5 py-4">
            <div className="flex items-center justify-between gap-4">
              <h2 className="font-semibold text-foreground">{row.title}</h2>
              <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-foreground">
                {row.state}
              </span>
            </div>
            <p className="mt-1.5 text-pretty text-sm/6 text-muted-foreground">{row.body}</p>
          </li>
        ))}
      </ul>
      <NotConnectedNote>
        Changing these reaches the registry once registration is switched on.
      </NotConnectedNote>
    </div>
  )
}

export default function SecurityPage({ params }: { params: Params }) {
  return (
    <Suspense
      fallback={<div aria-hidden="true" className="h-64 animate-pulse rounded-2xl bg-muted" />}
    >
      <Security params={params} />
    </Suspense>
  )
}
