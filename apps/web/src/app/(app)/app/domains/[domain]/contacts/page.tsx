import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
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
    <div className="max-w-2xl space-y-6">
      <section
        aria-labelledby="registrant-heading"
        className="rounded-2xl border border-border p-5 text-sm/6"
      >
        <h2 id="registrant-heading" className="font-semibold text-foreground">
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
      </section>
      <PanelNote title="Not editable here yet.">
        Changing contacts from here is not built yet.
      </PanelNote>
    </div>
  )
}

export default function ContactsPage({ params }: { params: Params }) {
  return (
    <Suspense
      fallback={<div aria-hidden="true" className="h-48 animate-pulse rounded-2xl bg-muted" />}
    >
      <Contacts params={params} />
    </Suspense>
  )
}
