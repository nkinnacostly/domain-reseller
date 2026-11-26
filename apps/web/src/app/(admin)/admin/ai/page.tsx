import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PanelPageSkeleton } from '@/components/layout/panel'
import { AiView } from '@/features/admin/components/ai/ai-view'

export const metadata: Metadata = { title: 'AI' }

/** What the AI features cost and whether they are working (AI phase 4, migration 75). Routing only. */
export default function AdminAiPage() {
  return (
    <Suspense fallback={<PanelPageSkeleton />}>
      <AiView />
    </Suspense>
  )
}
