import { formatNaira } from '@dr/shared'
import { cn } from '@/lib/utils'
import { REFUND_STATE, refundDetail, refundLabel } from '../lib/refunds'
import type { OrderRefund } from '../queries/orders'

const dateFormat = new Intl.DateTimeFormat('en-NG', {
  dateStyle: 'medium',
  timeZone: 'Africa/Lagos',
})

/** The refunds on an order (FR-R3). Shown only when there are some. */
export function OrderRefunds({ refunds }: { refunds: OrderRefund[] }) {
  if (refunds.length === 0) return null
  return (
    <section aria-labelledby="refunds-heading" className="mt-8">
      <h2 id="refunds-heading" className="text-lg font-semibold text-foreground">
        Refunds
      </h2>
      <ul className="mt-4 divide-y divide-border/70 rounded-2xl border border-border">
        {refunds.map((refund) => (
          <li
            key={refund.id}
            data-refund-state={refund.state}
            className="flex flex-col gap-1 px-5 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6"
          >
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-semibold break-all text-foreground">
                  {refundLabel(refund)}
                </span>
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-xs font-medium text-foreground',
                    refund.state === 'refunded' ? 'bg-status-active/15' : 'bg-muted',
                  )}
                >
                  {REFUND_STATE[refund.state] ?? refund.state}
                </span>
              </p>
              <p className="mt-1 text-pretty text-sm text-muted-foreground">
                {refundDetail(refund, (iso) => dateFormat.format(new Date(iso)))}
              </p>
            </div>
            <p className="shrink-0 font-medium text-foreground tabular-nums">
              {formatNaira(refund.amountKobo)}
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}
