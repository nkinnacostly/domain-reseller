import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PricingPageSkeleton } from '@/features/admin/components/pricing/pricing-header'
import { PricingView } from '@/features/admin/components/pricing/pricing-view'

export const metadata: Metadata = { title: 'Pricing' }

/** How a price is built, and the settings it is built from (docs/ADMIN-SPEC.md §5.2 B12). Routing only. */
export default function AdminPricingPage() {
  return (
    <Suspense fallback={<PricingPageSkeleton cards={3} />}>
      <PricingView />
    </Suspense>
  )
}
