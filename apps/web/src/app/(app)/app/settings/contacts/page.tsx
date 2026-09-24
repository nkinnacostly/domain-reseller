import type { Metadata } from 'next'
import { Suspense } from 'react'
import { FormMessage } from '@/components/common/form-parts'
import { PanelHeader, PanelPage, PanelSkeleton } from '@/components/layout/panel'
import { ContactProfiles } from '@/features/contacts/components/contact-profiles'
import { listContactProfiles } from '@/features/contacts/queries/profiles'

export const metadata: Metadata = { title: 'Contacts' }

/** FR-A4 — saved contacts, read as the user (RLS). */
async function Profiles() {
  const profiles = await listContactProfiles()
  if (!profiles) {
    return (
      <FormMessage tone="error">
        Your saved contacts couldn’t be loaded just now.{' '}
        <a href="/app/settings/contacts" className="font-medium underline underline-offset-2">
          Try again
        </a>
      </FormMessage>
    )
  }
  return <ContactProfiles profiles={profiles} />
}

export default function ContactProfilesPage() {
  return (
    <PanelPage>
      <PanelHeader
        crumbs={[
          { label: 'Home', href: '/' },
          { label: 'Dashboard', href: '/app/domains' },
          { label: 'Settings', href: '/app/settings' },
          { label: 'Contacts' },
        ]}
        title="Contacts"
        description="Details you can reuse for your domains. Your default fills in the registrant — the legal owner — at checkout, and any contact can be picked as the administrative, technical or billing contact, at checkout or from a domain’s Contacts tab. Domains keep their own copy, so editing one here changes no domain."
      />
      <Suspense fallback={<PanelSkeleton height="h-72" />}>
        <Profiles />
      </Suspense>
    </PanelPage>
  )
}
