import type { Metadata } from 'next'
import { Suspense } from 'react'
import { CustomerView } from '@/features/admin/components/customers/customer-view'
import { CustomerSkeleton } from '@/features/admin/components/customers/customers-skeleton'

export const metadata: Metadata = { title: 'Customer orders' }

type Search = Promise<Record<string, string | string[] | undefined>>

/** One account's orders on the side shown (docs/ADMIN-SPEC.md §5.2, B8). */
export default function AdminCustomerOrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Search
}) {
  return (
    <Suspense fallback={<CustomerSkeleton />}>
      <CustomerView params={params} tab="orders" searchParams={searchParams} />
    </Suspense>
  )
}
