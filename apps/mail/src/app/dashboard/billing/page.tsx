import type { Metadata } from 'next'
import { Suspense } from 'react'
import { Container } from '@/components/layout/container'
import { PageSkeleton } from '@/features/accounts/components/dashboard-skeleton'
import { getCurrentAccount } from '@/features/accounts/queries/accounts'
import { BillingPage } from '@/features/billing/components/billing-page'

export const metadata: Metadata = { title: 'Billing' }

type Params = Promise<{ payment?: string }>

/** MAIL-SPEC §8, §10: plan, period, use of the caps, changing plan, tax invoices. */
async function Billing({ searchParams }: { searchParams: Params }) {
  const [data, { payment }] = await Promise.all([getCurrentAccount(), searchParams])
  if (!data) return null
  return <BillingPage data={data} payment={payment} />
}

export default function Page({ searchParams }: { searchParams: Params }) {
  return (
    <Suspense
      fallback={
        <Container className="py-6 sm:py-8">
          <PageSkeleton />
        </Container>
      }
    >
      <Billing searchParams={searchParams} />
    </Suspense>
  )
}
