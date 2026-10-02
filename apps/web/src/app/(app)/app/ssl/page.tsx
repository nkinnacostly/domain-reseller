import { Plus } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import {
  FOCUS,
  Panel,
  PanelHeader,
  PanelPage,
  PanelSkeleton,
  ROUND_LINK,
} from '@/components/layout/panel'
import { CertificateList } from '@/features/ssl/components/certificate-list'
import { listMyCertificates } from '@/features/ssl/queries/certificates'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'SSL certificates' }

async function Certificates() {
  const certificates = await listMyCertificates()
  return (
    <Panel labelledBy="certificates-heading">
      <h2 id="certificates-heading" className="sr-only">
        Your SSL certificates
      </h2>
      <CertificateList certificates={certificates} />
    </Panel>
  )
}

/** FR-SSL-7: every certificate on the account, and its next step. */
export default function CertificatesPage() {
  return (
    <PanelPage>
      <PanelHeader
        crumbs={[
          { label: 'Home', href: '/' },
          { label: 'Dashboard', href: '/app/domains' },
          { label: 'Certificates' },
        ]}
        title="SSL certificates"
        description="Set each one up, approve it, then download it and install it on your server or hosting."
        actions={
          <Link
            href="/ssl"
            aria-label="Buy an SSL certificate"
            className={cn(ROUND_LINK, 'rounded-xl', FOCUS)}
          >
            <Plus className="size-5" aria-hidden="true" />
          </Link>
        }
      />
      <Suspense fallback={<PanelSkeleton />}>
        <Certificates />
      </Suspense>
    </PanelPage>
  )
}
