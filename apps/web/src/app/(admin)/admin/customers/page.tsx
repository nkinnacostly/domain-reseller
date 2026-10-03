import type { Metadata } from 'next'
import { Suspense } from 'react'
import { CustomersSkeleton } from '@/features/admin/components/customers/customers-skeleton'
import { CustomersView } from '@/features/admin/components/customers/customers-view'

export const metadata: Metadata = { title: 'Customers' }

type Search = Promise<Record<string, string | string[] | undefined>>

/** Every account, masked; found by email only through a POST (docs/ADMIN-SPEC.md §5.2, B8). */
export default function AdminCustomersPage({ searchParams }: { searchParams: Search }) {
  return (
    <Suspense fallback={<CustomersSkeleton />}>
      <CustomersView searchParams={searchParams} />
    </Suspense>
  )
}
