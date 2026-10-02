import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { PanelHeader, PanelPage, PanelPageSkeleton } from '@/components/layout/panel'
import { defaultRegistrant } from '@/features/checkout/queries/registrant'
import { CertificateDetail } from '@/features/ssl/components/certificate-detail'
import { CertificateStatus } from '@/features/ssl/components/certificate-status'
import { certificateState } from '@/features/ssl/lib/status'
import { getMyCertificate } from '@/features/ssl/queries/certificates'
import { createClient } from '@/lib/supabase/server'

export const metadata: Metadata = { title: 'SSL certificate' }

type Params = Promise<{ id: string }>

async function Certificate({ params }: { params: Params }) {
  const { id } = await params
  const certificate = await getMyCertificate(id)
  if (!certificate) notFound()
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const contact = await defaultRegistrant(supabase, { id: certificate.user_id, email: user?.email })
  const now = new Date()

  return (
    <>
      <PanelHeader
        crumbs={[
          { label: 'Home', href: '/' },
          { label: 'Dashboard', href: '/app/domains' },
          { label: 'Certificates', href: '/app/ssl' },
          { label: certificate.common_name },
        ]}
        title={<span className="break-all">{certificate.common_name}</span>}
        titleAside={
          <CertificateStatus
            state={certificateState(certificate.status, certificate.expires_at, now)}
          />
        }
        description={certificate.product_name}
      />
      <CertificateDetail certificate={certificate} contact={contact} now={now} />
    </>
  )
}

/** FR-SSL-4 – FR-SSL-8: one certificate — its set-up, its approval, the issued files and reissues. */
export default function CertificatePage({ params }: { params: Params }) {
  return (
    <PanelPage>
      <Suspense fallback={<PanelPageSkeleton />}>
        <Certificate params={params} />
      </Suspense>
    </PanelPage>
  )
}
