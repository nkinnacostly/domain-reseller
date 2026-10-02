import { formatNaira } from '@dr/shared'
import { DomainName } from '@/components/common/domain-name'
import { Brand } from '@/components/layout/brand'
import { PANEL } from '@/components/layout/panel'
import { OrderRefunds } from '@/features/checkout/components/order-refunds'
import type { OrderRefund } from '@/features/checkout/queries/orders'
import { BUSINESS } from '@/lib/business'
import { cn } from '@/lib/utils'
import { lineLabel, notDoneLabel, type Receipt, receiptDate, renewalText } from '../lib/receipt'

const LABEL = 'text-xs font-medium tracking-wide text-muted-foreground uppercase'

/**
 * The receipt itself (CMP-17, FR-C5, N8): who sold — with the company's CAC
 * number and TIN — who bought, every line with its renewal price, VAT at the
 * order's own rate, the payment, and any refunds. A live one is a tax
 * invoice; a test one says it is not. On paper the card falls away and only
 * this prints. Seller facts come from `BUSINESS` alone (N9b).
 */
export function ReceiptDocument({
  receipt,
  refunds,
}: {
  receipt: Receipt
  refunds: OrderRefund[]
}) {
  const { customer, payment } = receipt
  return (
    <article
      aria-labelledby="receipt-heading"
      className={cn(
        PANEL,
        'p-5 sm:p-8 print:rounded-none print:border-0 print:bg-transparent print:p-0 print:shadow-none',
      )}
    >
      {receipt.testMode ? (
        <p className="mb-6 rounded-xl border border-border bg-muted px-4 py-3 text-pretty text-sm/6 text-foreground">
          <span className="font-semibold">Test payment — not a tax invoice.</span> It was paid with
          Flutterwave test keys, so no money moved.
        </p>
      ) : null}

      <header className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
        <div>
          {/* The mark is white on blue: keep its fill when printed. */}
          <Brand className="[print-color-adjust:exact]" />
          <h2
            id="receipt-heading"
            className="mt-5 text-2xl font-semibold tracking-tight text-foreground"
          >
            {receipt.testMode ? 'Receipt' : 'Tax invoice'}
          </h2>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm sm:text-right">
          <dt className="text-muted-foreground">Invoice number</dt>
          <dd data-invoice-number className="font-medium text-foreground tabular-nums">
            {receipt.invoiceNumber}
          </dd>
          <dt className="text-muted-foreground">Date paid</dt>
          <dd className="text-foreground">{receiptDate(receipt.paidAt)}</dd>
          <dt className="text-muted-foreground">Order</dt>
          <dd className="text-foreground tabular-nums">{receipt.orderNumber}</dd>
        </dl>
      </header>

      <div className="mt-8 grid gap-6 text-sm/6 sm:grid-cols-2">
        <section aria-labelledby="seller-heading">
          <h3 id="seller-heading" className={LABEL}>
            From
          </h3>
          <p className="mt-2 text-foreground">
            <span className="font-medium">{BUSINESS.operator}</span>
            <br />
            <span className="text-muted-foreground">Operator of {BUSINESS.brand}</span>
            <br />
            {BUSINESS.rcNumber}
            <br />
            TIN {BUSINESS.tin}
            <br />
            {BUSINESS.site}
            <br />
            {BUSINESS.email}
          </p>
        </section>
        <section aria-labelledby="customer-heading">
          <h3 id="customer-heading" className={LABEL}>
            Billed to
          </h3>
          {customer.name || customer.email || customer.address.length > 0 ? (
            <p className="mt-2 break-words text-foreground">
              {customer.name ? <span className="block font-medium">{customer.name}</span> : null}
              {customer.company ? <span className="block">{customer.company}</span> : null}
              {customer.email ? <span className="block">{customer.email}</span> : null}
              {customer.address.map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </p>
          ) : (
            <p className="mt-2 text-muted-foreground">No registrant details were recorded.</p>
          )}
        </section>
      </div>

      {/* S5 — a wide table scrolls inside its own box; `relative` keeps sr-only text in it. */}
      <div className="relative mt-8 overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">What this order paid for</caption>
          <thead>
            <tr className="border-border border-b text-left">
              <th scope="col" className={cn(LABEL, 'pb-2 font-medium')}>
                Item
              </th>
              <th scope="col" className={cn(LABEL, 'pb-2 pl-4 text-right font-medium')}>
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {receipt.lines.map((line) => (
              <tr key={line.id} className="border-border border-b align-top">
                <td className="py-3">
                  <p className="font-medium break-all text-foreground">
                    <DomainName name={line.domain} />
                  </p>
                  <p className="text-muted-foreground">
                    {lineLabel(line.kind, line.years)} · {renewalText(line)}
                  </p>
                  {line.failed ? (
                    <p data-line-failed className="text-foreground">
                      {notDoneLabel(line.kind)}
                    </p>
                  ) : null}
                </td>
                <td className="py-3 pl-4 text-right font-medium whitespace-nowrap text-foreground tabular-nums">
                  {formatNaira(line.priceKobo)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" className="pt-3 text-left font-normal text-muted-foreground">
                Subtotal
              </th>
              <td className="pt-3 pl-4 text-right whitespace-nowrap text-foreground tabular-nums">
                {formatNaira(receipt.subtotalKobo)}
              </td>
            </tr>
            <tr>
              <th scope="row" className="pt-1.5 text-left font-normal text-muted-foreground">
                VAT ({receipt.vatPct}%)
              </th>
              <td className="pt-1.5 pl-4 text-right whitespace-nowrap text-foreground tabular-nums">
                {formatNaira(receipt.vatKobo)}
              </td>
            </tr>
            <tr className="text-base">
              <th scope="row" className="pt-3 text-left font-semibold text-foreground">
                Total
              </th>
              <td className="pt-3 pl-4 text-right font-bold whitespace-nowrap text-foreground tabular-nums">
                {formatNaira(receipt.totalKobo)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <section aria-labelledby="payment-heading" className="mt-8 text-sm/6">
        <h3 id="payment-heading" className={LABEL}>
          Payment
        </h3>
        <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Method</dt>
            <dd className="text-foreground">{payment.method}</dd>
          </div>
          {payment.amountKobo !== null ? (
            <div>
              <dt className="text-muted-foreground">Amount paid</dt>
              <dd className="text-foreground tabular-nums">{formatNaira(payment.amountKobo)}</dd>
            </div>
          ) : null}
          <div>
            <dt className="text-muted-foreground">Payment reference</dt>
            <dd className="font-mono text-xs/6 break-all text-foreground">{payment.reference}</dd>
          </div>
          {payment.transactionId ? (
            <div>
              <dt className="text-muted-foreground">Flutterwave transaction</dt>
              <dd className="font-mono text-xs/6 break-all text-foreground">
                {payment.transactionId}
              </dd>
            </div>
          ) : null}
        </dl>
      </section>

      <OrderRefunds refunds={refunds} />

      <p className="mt-8 border-border border-t pt-4 text-pretty text-xs/5 text-muted-foreground">
        Amounts are in Nigerian naira, with VAT at {receipt.vatPct}% on the order. Questions about
        this receipt: {BUSINESS.email}.
      </p>
    </article>
  )
}
