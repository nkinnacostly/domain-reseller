import type { Metadata } from 'next'
import { Suspense } from 'react'
import { FormMessage } from '@/components/common/form-parts'
import { PanelHeader, PanelPage, PanelSkeleton } from '@/components/layout/panel'
import { LabelManager } from '@/features/domains/components/label-manager'
import { getLabels } from '@/features/domains/queries/labels'

export const metadata: Metadata = { title: 'Labels' }

/** FR-P3 — the account's labels, read as the user (RLS). */
async function Labels() {
  const labels = await getLabels()
  if (!labels) {
    return (
      <FormMessage tone="error">
        Your labels couldn’t be loaded just now.{' '}
        <a href="/app/settings/labels" className="font-medium underline underline-offset-2">
          Try again
        </a>
      </FormMessage>
    )
  }
  return <LabelManager labels={labels} />
}

export default function LabelsPage() {
  return (
    <PanelPage>
      <PanelHeader
        crumbs={[
          { label: 'Home', href: '/' },
          { label: 'Dashboard', href: '/app/domains' },
          { label: 'Settings', href: '/app/settings' },
          { label: 'Labels' },
        ]}
        title="Labels"
        description="Coloured tags for your domains — by client, project or anything else. A domain can carry several, and your domains list can be filtered by any of them."
      />
      <Suspense fallback={<PanelSkeleton height="h-72" />}>
        <Labels />
      </Suspense>
    </PanelPage>
  )
}
