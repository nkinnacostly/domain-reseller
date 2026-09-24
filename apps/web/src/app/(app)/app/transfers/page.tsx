import { Plus } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import {
  FOCUS,
  Panel,
  PanelHeader,
  PanelPage,
  PanelSkeleton,
  ROUND_LINK,
} from '@/components/layout/panel'
import { TransferList } from '@/features/transfers/components/transfer-list'
import { getTransfers } from '@/features/transfers/queries/transfers'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Transfers' }

async function Transfers() {
  const transfers = await getTransfers()
  return (
    <Panel labelledBy="transfers-heading">
      <h2 id="transfers-heading" className="sr-only">
        Your transfers
      </h2>
      <TransferList transfers={transfers} />
    </Panel>
  )
}

/** PRD E9 — every transfer in on the account, and where each one stands. */
export default function TransfersPage() {
  return (
    <PanelPage>
      <PanelHeader
        crumbs={[
          { label: 'Home', href: '/' },
          { label: 'Dashboard', href: '/app/domains' },
          { label: 'Transfers' },
        ]}
        title="Transfers"
        description="Domains you’re moving here from another registrar. A transfer usually takes up to 5 days once the registry has the request."
        actions={
          <Link
            href="/transfer"
            aria-label="Transfer a domain here"
            className={cn(ROUND_LINK, 'rounded-xl', FOCUS)}
          >
            <Plus className="size-5" aria-hidden="true" />
          </Link>
        }
      />
      <Suspense fallback={<PanelSkeleton />}>
        <Transfers />
      </Suspense>
    </PanelPage>
  )
}
