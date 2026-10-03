import type { Metadata } from 'next'
import { Suspense } from 'react'
import { CustomerView } from '@/features/admin/components/customers/customer-view'
import { CustomerSkeleton } from '@/features/admin/components/customers/customers-skeleton'

export const metadata: Metadata = { title: 'Customer certificates' }

/** One account's certificates, from its orders on the side shown (docs/ADMIN-SPEC.md §5.2, B8). */
export default function AdminCustomerCertificatesPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  return (
    <Suspense fallback={<CustomerSkeleton />}>
      <CustomerView params={params} tab="certificates" />
    </Suspense>
  )
}
