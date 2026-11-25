import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PanelPageSkeleton } from '@/components/layout/panel'
import { ScreeningView } from '@/features/admin/components/screening/screening-view'

export const metadata: Metadata = { title: 'Name checks' }

/** New paid names that look like a brand or a sign-in page (migration 73). Routing only. */
export default function AdminScreeningPage() {
  return (
    <Suspense fallback={<PanelPageSkeleton />}>
      <ScreeningView />
    </Suspense>
  )
}
