import type { Metadata } from 'next'
import { Suspense } from 'react'
import { AuditSkeleton, AuditView } from '@/features/admin/components/audit/audit-view'

export const metadata: Metadata = { title: 'Audit log' }

/** The audit log, read-only (docs/ADMIN-SPEC.md §5.2 B14). `searchParams` is read inside Suspense. */
export default function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  return (
    <Suspense fallback={<AuditSkeleton />}>
      <AuditView searchParams={searchParams} />
    </Suspense>
  )
}
