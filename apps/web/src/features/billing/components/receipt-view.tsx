import Link from 'next/link'
import { FormMessage } from '@/components/common/form-parts'
import { type Crumb, FOCUS, PANEL_HEADING, Panel, PanelHeader } from '@/components/layout/panel'
import { cn } from '@/lib/utils'
import { receiptDate } from '../lib/receipt'
import type { ReceiptLookup } from '../queries/receipt'
import { PrintButton } from './print-button'
import { ReceiptDocument } from './receipt-document'

const BACK_LINK = cn(
  'mt-4 inline-flex h-11 items-center rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition-colors hover:bg-brand-subtle active:scale-[0.98]',
  FOCUS,
)

function crumbs(order?: { id: string; number: string }): Crumb[] {
  return [
    { label: 'Home', href: '/' },
    { label: 'Dashboard', href: '/app/domains' },
    { label: 'Orders', href: '/app/orders' },
    ...(order ? [{ label: order.number, href: `/app/orders/${order.id}` }] : []),
    { label: 'Receipt' },
  ]
}

/**
 * The receipt page's states (S11): the receipt, an order that has none
 * because it was never paid, and a read that failed. On paper only the
 * receipt prints — the header with its links and button is screen-only.
 */
export function ReceiptView({ lookup }: { lookup: Exclude<ReceiptLookup, { state: 'missing' }> }) {
  if (lookup.state === 'error') {
    return (
      <>
        <PanelHeader crumbs={crumbs()} title="Receipt" />
        <Panel>
          <FormMessage tone="error">
            We couldn’t load this receipt just now. Refresh the page to try again.
          </FormMessage>
          <Link href="/app/orders" className={BACK_LINK}>
            Back to your orders
          </Link>
        </Panel>
      </>
    )
  }

  if (lookup.state === 'unpaid') {
    const order = { id: lookup.orderId, number: lookup.orderNumber }
    return (
      <>
        <PanelHeader crumbs={crumbs(order)} title="Receipt" />
        <Panel labelledBy="no-receipt-heading">
          <h2 id="no-receipt-heading" className={PANEL_HEADING}>
            No receipt for this order
          </h2>
          <p className="mt-1.5 max-w-2xl text-pretty text-sm/6 text-muted-foreground">
            Order {lookup.orderNumber} has not been paid, so it has no receipt. A receipt, with its
            invoice number, is issued as soon as a payment for the order is confirmed.
          </p>
          <Link href={`/app/orders/${lookup.orderId}`} className={BACK_LINK}>
            Back to the order
          </Link>
        </Panel>
      </>
    )
  }

  const { receipt, refunds } = lookup
  return (
    <>
      <div className="print:hidden">
        <PanelHeader
          crumbs={crumbs({ id: receipt.orderId, number: receipt.orderNumber })}
          title={`Receipt ${receipt.invoiceNumber}`}
          description={`For order ${receipt.orderNumber}, paid ${receiptDate(receipt.paidAt)}. To keep a copy, choose “Save as PDF” in the print dialog.`}
        >
          <PrintButton />
        </PanelHeader>
      </div>
      <ReceiptDocument receipt={receipt} refunds={refunds} />
    </>
  )
}
