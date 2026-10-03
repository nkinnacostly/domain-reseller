import type { Metadata } from 'next'
import { Suspense } from 'react'
import { CertificateView } from '@/features/admin/components/ssl/certificate-view'
import { CertificateSkeleton } from '@/features/admin/components/ssl/ssl-skeleton'

export const metadata: Metadata = { title: 'Certificate' }

/** One certificate, read only, with a status read on a click (docs/ADMIN-SPEC.md §5.2, B10). */
export default function AdminSslDetailPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<CertificateSkeleton />}>
      <CertificateView params={params} />
    </Suspense>
  )
}
