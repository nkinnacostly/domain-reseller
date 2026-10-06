import type { Metadata } from 'next'
import { Suspense } from 'react'
import { Container } from '@/components/layout/container'
import { PageSkeleton } from '@/features/accounts/components/dashboard-skeleton'
import { InvoicePage } from '@/features/billing/components/invoice-page'

export const metadata: Metadata = { title: 'Invoice' }

type Params = Promise<{ id: string }>

async function Invoice({ params }: { params: Params }) {
  const { id } = await params
  return <InvoicePage id={id} />
}

/** One tax invoice, printable (MAIL-SPEC §8). */
export default function Page({ params }: { params: Params }) {
  return (
    <Suspense
      fallback={
        <Container className="py-6 sm:py-8">
          <PageSkeleton />
        </Container>
      }
    >
      <Invoice params={params} />
    </Suspense>
  )
}
