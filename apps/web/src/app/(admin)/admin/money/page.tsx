import type { Metadata } from 'next'
import { Suspense } from 'react'
import { MoneySkeleton } from '@/features/admin/components/money/money-skeleton'
import { type MoneySearch, MoneyView } from '@/features/admin/components/money/money-view'

export const metadata: Metadata = { title: 'Money' }

/** Sales, VAT, refunds, fees and margin (docs/ADMIN-SPEC.md §5.2 B7). Routing only. */
export default function AdminMoneyPage({ searchParams }: { searchParams: Promise<MoneySearch> }) {
  return (
    <Suspense fallback={<MoneySkeleton />}>
      <MoneyView searchParams={searchParams} />
    </Suspense>
  )
}
