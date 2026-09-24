import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { PANEL_HEADING, Panel, PanelSkeleton } from '@/components/layout/panel'
import { PanelNote } from '@/features/domains/components/domain-badges'
import { getDomain } from '@/features/domains/queries/domains'

export const metadata: Metadata = { title: 'Contacts' }
type Params = Promise<{ domain: string }>

async function Contacts({ params }: { params: Params }) {
  const { domain: name } = await params
  const domain = await getDomain(name)
  if (!domain) notFound()
  const r = domain.registrant

  return (
    <Panel labelledBy="registrant-heading" className="text-sm/6">
      <div className="max-w-2xl">
        <h2 id="registrant-heading" className={PANEL_HEADING}>
          Registrant — the legal owner
        </h2>
        {r ? (
          <p className="mt-2 text-muted-foreground">
            {r.firstName} {r.lastName}
            {r.company ? `, ${r.company}` : ''}
            <br />
            {r.email} · +{r.phoneCountryCode} {r.phone}
            <br />
            {r.addressLine1}, {r.city}, {r.state} {r.zipCode}, {r.country}
          </p>
        ) : (
          <p className="mt-2 text-muted-foreground">Not recorded.</p>
        )}
        <p className="mt-3 text-muted-foreground">
          The same details are used for the admin, technical and billing contacts.
        </p>
        <div className="mt-5">
          <PanelNote title="Not editable here yet.">
            Changing contacts from here is not built yet.
          </PanelNote>
        </div>
      </div>
    </Panel>
  )
}

export default function ContactsPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<PanelSkeleton height="h-48" />}>
      <Contacts params={params} />
    </Suspense>
  )
}
