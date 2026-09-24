import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { PANEL_HEADING, Panel, PanelSkeleton } from '@/components/layout/panel'
import { getAccount } from '@/features/auth/queries/account'
import type { RegistrantForm as RegistrantValues } from '@/features/checkout/lib/contact'
import { profileOption } from '@/features/contacts/lib/profiles'
import { CONTACT_ROLES, registrantAlsoHolds, roleStart } from '@/features/contacts/lib/roles'
import { listContactProfiles } from '@/features/contacts/queries/profiles'
import { ContactRoleForm } from '@/features/domains/components/contact-role-form'
import {
  CONTACTS_WAIT_NOTE,
  ContactRolesSummary,
} from '@/features/domains/components/contact-roles-summary'
import { PanelNote } from '@/features/domains/components/domain-badges'
import { RegistrantForm } from '@/features/domains/components/registrant-form'
import { RegistrantSummary } from '@/features/domains/components/registrant-summary'
import { NeedsTwoFactor } from '@/features/domains/components/settings-parts'
import { privacyOffered, settingsAvailability } from '@/features/domains/lib/settings'
import { getDomain } from '@/features/domains/queries/domains'
import { getDomainSettings } from '@/features/domains/queries/settings'

export const metadata: Metadata = { title: 'Contacts' }
type Params = Promise<{ domain: string }>

/**
 * FR-DS1, FR-DS2 — all four contacts: the registrant, and the
 * administrative, technical and billing contacts (migration 29), each
 * changed by a request the registry confirms.
 */
async function Contacts({ params }: { params: Params }) {
  const { domain: name } = await params
  const [domain, account] = await Promise.all([getDomain(name), getAccount()])
  if (!domain) notFound()
  const [settings, profiles] = await Promise.all([
    getDomainSettings(domain.id),
    listContactProfiles(),
  ])
  const availability = settingsAvailability(domain)
  const requested = settings.pendingRegistrant
  const alsoHolds = registrantAlsoHolds(settings.pendingContacts ?? settings.contacts)
  const saved = profiles ?? []

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_1.4fr]">
      <Panel labelledBy="registrant-heading" className="h-fit text-sm/6">
        <h2 id="registrant-heading" className={PANEL_HEADING}>
          Registrant — the legal owner
        </h2>
        <RegistrantSummary registrant={domain.registrant} className="mt-2 text-muted-foreground" />
        {alsoHolds ? <p className="mt-3 text-muted-foreground">{alsoHolds}</p> : null}
        {requested ? (
          <div className="mt-5 rounded-xl bg-muted/60 px-4 py-3">
            <p className="font-medium text-foreground">Waiting for the registry</p>
            <p className="text-muted-foreground">
              These new details are on their way and replace the ones above once the registry
              confirms them:
            </p>
            <RegistrantSummary registrant={requested} className="mt-2 text-foreground" />
            <p className="mt-2 text-pretty text-muted-foreground">{CONTACTS_WAIT_NOTE}</p>
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

      <Panel labelledBy="roles-heading" className="h-fit text-sm/6">
        <h2 id="roles-heading" className={PANEL_HEADING}>
          Administrative, technical and billing
        </h2>
        <ContactRolesSummary contacts={settings.contacts} pending={settings.pendingContacts} />
      </Panel>

      {/* Why a domain cannot be changed is said once, beside the registrant. */}
      {availability.editable ? (
        <Panel labelledBy="change-roles-heading" className="h-fit">
          <h2 id="change-roles-heading" className={PANEL_HEADING}>
            Change the other contacts
          </h2>
          <p className="mt-1.5 text-pretty text-sm/6 text-muted-foreground">
            Each is the registrant unless you choose someone else. Changes are sent to the registry
            with the registrant, and show here once it confirms them.{' '}
            <Link
              href="/app/settings/contacts"
              className="font-medium text-foreground underline underline-offset-2"
            >
              Manage saved contacts
            </Link>
          </p>
          {account?.totpFactor ? (
            <div className="mt-6 divide-y divide-border">
              {CONTACT_ROLES.map((role) => (
                <div key={role} className="py-6 first:pt-0 last:pb-0">
                  <ContactRoleForm
                    domainId={domain.id}
                    domain={domain.domainName}
                    contactRole={role}
                    profiles={saved.map(profileOption)}
                    start={roleStart((settings.pendingContacts ?? settings.contacts)[role], saved)}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-6">
              <NeedsTwoFactor>
                Changing a domain’s contacts needs two-factor authentication on your account.
              </NeedsTwoFactor>
            </div>
          )}
        </Panel>
      ) : null}
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
