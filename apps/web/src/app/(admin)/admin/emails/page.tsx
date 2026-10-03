import type { Metadata } from 'next'
import { Suspense } from 'react'
import { EmailsSkeleton, EmailsView } from '@/features/admin/components/emails/emails-view'

export const metadata: Metadata = { title: 'Emails' }

type Search = Promise<Record<string, string | string[] | undefined>>

/**
 * The email outbox and the compliance notices sent (docs/ADMIN-SPEC.md
 * §5.2, B11). The URL holds the tab and the list: `?status=failed` opens
 * the failed emails, `?tab=compliance` the notices.
 */
export default function AdminEmailsPage({ searchParams }: { searchParams: Search }) {
  return (
    <Suspense fallback={<EmailsSkeleton />}>
      <EmailsView searchParams={searchParams} />
    </Suspense>
  )
}
