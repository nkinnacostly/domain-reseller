import type { Metadata } from 'next'
import { Suspense } from 'react'
import { CustomerView } from '@/features/admin/components/customers/customer-view'
import { CustomerSkeleton } from '@/features/admin/components/customers/customers-skeleton'

export const metadata: Metadata = { title: 'Customer emails' }

/** One account's emails (docs/ADMIN-SPEC.md §5.2, B8). */
export default function AdminCustomerEmailsPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<CustomerSkeleton />}>
      <CustomerView params={params} tab="emails" />
    </Suspense>
  )
}
