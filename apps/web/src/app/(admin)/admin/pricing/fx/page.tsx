import type { Metadata } from 'next'
import { Suspense } from 'react'
import { FxView } from '@/features/admin/components/pricing/fx-view'
import { PricingPageSkeleton } from '@/features/admin/components/pricing/pricing-header'

export const metadata: Metadata = { title: 'Exchange rates' }

/** The active rate, and rates held for review (docs/ADMIN-SPEC.md §5.2 B12). Routing only. */
export default function AdminPricingFxPage() {
  return (
    <Suspense fallback={<PricingPageSkeleton cards={3} />}>
      <FxView />
    </Suspense>
  )
}
