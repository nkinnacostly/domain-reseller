import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SslListView } from '@/features/admin/components/ssl/ssl-list-view'
import { SslListSkeleton } from '@/features/admin/components/ssl/ssl-skeleton'

export const metadata: Metadata = { title: 'Certificates' }

type Search = Promise<Record<string, string | string[] | undefined>>

/** Every certificate on the side (docs/ADMIN-SPEC.md §5.2, B10). The URL holds the list. */
export default function AdminSslPage({ searchParams }: { searchParams: Search }) {
  return (
    <Suspense fallback={<SslListSkeleton />}>
      <SslListView searchParams={searchParams} />
    </Suspense>
  )
}
