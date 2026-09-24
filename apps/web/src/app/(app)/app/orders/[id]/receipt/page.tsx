import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { PanelPage, PanelPageSkeleton } from '@/components/layout/panel'
import { ReceiptView } from '@/features/billing/components/receipt-view'
import { getReceipt } from '@/features/billing/queries/receipt'

export const metadata: Metadata = { title: 'Receipt' }

type Params = Promise<{ id: string }>

async function Receipt({ params }: { params: Params }) {
  const { id } = await params
  const lookup = await getReceipt(id)
  // Not an order, or someone else's: RLS cannot tell us which, and neither do we.
  if (lookup.state === 'missing') notFound()
  return <ReceiptView lookup={lookup} />
}

/** CMP-17 — a paid order's receipt, printable on its own (print styles hide the panel). */
export default function ReceiptPage({ params }: { params: Params }) {
  return (
    <PanelPage className="print:p-0">
      <Suspense fallback={<PanelPageSkeleton />}>
        <Receipt params={params} />
      </Suspense>
    </PanelPage>
  )
}
