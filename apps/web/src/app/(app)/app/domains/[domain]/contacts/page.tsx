import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { PANEL_HEADING, Panel, PanelSkeleton } from '@/components/layout/panel'
import { getAccount } from '@/features/auth/queries/account'
import type { RegistrantForm as RegistrantValues } from '@/features/checkout/lib/contact'
import { PanelNote } from '@/features/domains/components/domain-badges'
import { RegistrantForm } from '@/features/domains/components/registrant-form'
import { RegistrantSummary } from '@/features/domains/components/registrant-summary'
import { NeedsTwoFactor } from '@/features/domains/components/settings-parts'
import { privacyOffered, settingsAvailability } from '@/features/domains/lib/settings'
import { getDomain } from '@/features/domains/queries/domains'
import { getDomainSettings } from '@/features/domains/queries/settings'

export const metadata: Metadata = { title: 'Contacts' }
type Params = Promise<{ domain: string }>

/** FR-DS1, FR-DS2 — the registrant, and a change of it sent to the registry. */
async function Contacts({ params }: { params: Params }) {
  const { domain: name } = await params
  const [domain, account] = await Promise.all([getDomain(name), getAccount()])
  if (!domain) notFound()
  const settings = await getDomainSettings(domain.id)
  const availability = settingsAvailability(domain)
  const requested = settings.pendingRegistrant

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_1.4fr]">
      <Panel labelledBy="registrant-heading" className="h-fit text-sm/6">
        <h2 id="registrant-heading" className={PANEL_HEADING}>
          Registrant — the legal owner
        </h2>
        <RegistrantSummary registrant={domain.registrant} className="mt-2 text-muted-foreground" />
        <p className="mt-3 text-muted-foreground">
          The same details are used for the admin, technical and billing contacts.
        </p>
        {requested ? (
          <div className="mt-5 rounded-xl bg-muted/60 px-4 py-3">
            <p className="font-medium text-foreground">Waiting for the registry</p>
            <p className="text-muted-foreground">
              These new details are on their way and replace the ones above once the registry
              confirms them:
            </p>
            <RegistrantSummary registrant={requested} className="mt-2 text-foreground" />
          </div>
        ) : null}
      </Panel>

      <Panel labelledBy="change-registrant-heading" className="h-fit">
        <h2 id="change-registrant-heading" className={PANEL_HEADING}>
          Change the registrant
        </h2>
        <p className="mt-1.5 text-pretty text-sm/6 text-muted-foreground">
          Keep these accurate: the registry publishes and checks them, and an owner it cannot reach
          can lose the domain. Changes are sent to the registry and show here once it confirms them.
        </p>
        {availability.note ? (
          <div className="mt-4">
            <PanelNote title={availability.note.title}>{availability.note.body}</PanelNote>
          </div>
        ) : null}
        {availability.editable ? (
          <div className="mt-6">
            {account?.totpFactor ? (
              <RegistrantForm
                domainId={domain.id}
                domain={domain.domainName}
                current={domain.registrant as RegistrantValues | null}
                requested={requested as RegistrantValues | null}
                generic={privacyOffered(domain.tld)}
              />
            ) : (
              <NeedsTwoFactor>
                The registrant is the domain’s legal owner, so changing it needs two-factor
                authentication on your account.
              </NeedsTwoFactor>
            )}
          </div>
        ) : null}
      </Panel>
    </div>
  )
}

export default function ContactsPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<PanelSkeleton height="h-96" />}>
      <Contacts params={params} />
    </Suspense>
  )
}
