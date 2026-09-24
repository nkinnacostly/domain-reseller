import { ReceiptText } from 'lucide-react'
import Link from 'next/link'
import { FOCUS } from '@/components/layout/panel'
import { cn } from '@/lib/utils'

/** The way from a paid order to its receipt (CMP-17). Only paid orders have one. */
export function ReceiptLink({
  orderId,
  invoiceNumber,
  className,
}: {
  orderId: string
  /** Shown when known, so a list of receipts can be told apart by number. */
  invoiceNumber?: string
  className?: string
}) {
  return (
    <Link
      href={`/app/orders/${orderId}/receipt`}
      className={cn(
        'inline-flex h-11 items-center gap-2 rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition-colors hover:bg-brand-subtle active:scale-[0.98]',
        FOCUS,
        className,
      )}
    >
      <ReceiptText className="size-4 shrink-0" aria-hidden="true" />
      {invoiceNumber ? `Receipt ${invoiceNumber}` : 'View receipt'}
    </Link>
  )
}
