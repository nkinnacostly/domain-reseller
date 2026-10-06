import { Brand } from '@/components/layout/brand'
import { BUSINESS } from '@/lib/business'
import { cn } from '@/lib/utils'
import type { Invoice } from '../lib/invoice'
import { formatKobo, vatPercent } from '../lib/money'
import { formatDay, formatPeriod } from '../lib/words'

const LABEL = 'text-xs font-medium tracking-wide text-muted-foreground uppercase'

/**
 * A tax invoice (MAIL-SPEC §8, as the shop's receipts: CMP-17): the seller
 * with its CAC number and TIN, the buyer as billed, every line, VAT at the
 * rate it was charged, and the payment. A test one says it is not a tax
 * invoice. On paper the card falls away and only this prints. Seller facts
 * come from `BUSINESS` alone (N9b).
 */
export function InvoiceDocument({ invoice }: { invoice: Invoice }) {
  return (
    <article
      aria-labelledby="invoice-heading"
      className="rounded-3xl border border-border bg-card p-5 sm:p-8 print:rounded-none print:border-0 print:bg-transparent print:p-0"
    >
      {invoice.testMode ? (
        <p className="mb-6 rounded-xl border border-border bg-muted px-4 py-3 text-pretty text-sm/6">
          <span className="font-semibold">Test payment — not a tax invoice.</span> It was paid with
          Flutterwave test keys, so no money moved.
        </p>
      ) : null}

      <header className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Brand className="[print-color-adjust:exact]" />
          <h1 id="invoice-heading" className="mt-5 text-2xl font-semibold tracking-tight">
            {invoice.testMode ? 'Receipt' : 'Tax invoice'}
          </h1>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm sm:text-right">
          <dt className="text-muted-foreground">Invoice number</dt>
          <dd data-invoice-number className="font-medium tabular-nums">
            {invoice.number}
          </dd>
          <dt className="text-muted-foreground">Date</dt>
          <dd>{formatDay(invoice.issuedAt)}</dd>
          <dt className="text-muted-foreground">Period</dt>
          <dd>{formatPeriod(invoice.periodStart, invoice.periodEnd)}</dd>
        </dl>
      </header>

      <div className="mt-8 grid gap-6 text-sm/6 sm:grid-cols-2">
        <section aria-labelledby="seller-heading">
          <h2 id="seller-heading" className={LABEL}>
            From
          </h2>
          <p className="mt-2">
            <span className="font-medium">{BUSINESS.operator}</span>
            <br />
            <span className="text-muted-foreground">Operator of {BUSINESS.product}</span>
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
        <section aria-labelledby="buyer-heading">
          <h2 id="buyer-heading" className={LABEL}>
            Billed to
          </h2>
          <p className="mt-2 break-words">
            <span className="block font-medium">{invoice.billedTo.name}</span>
            {invoice.billedTo.website ? (
              <span className="block">{invoice.billedTo.website}</span>
            ) : null}
          </p>
        </section>
      </div>

      {/* S5 — a wide table scrolls inside its own box; `relative` keeps sr-only text in it. */}
      <div className="relative mt-8 overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">What this invoice is for</caption>
          <thead>
            <tr className="border-b border-border text-left">
              <th scope="col" className={cn(LABEL, 'pb-2 font-medium')}>
                Item
              </th>
              <th scope="col" className={cn(LABEL, 'pb-2 pl-4 text-right font-medium')}>
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((line) => (
              <tr key={line.description} className="border-b border-border align-top">
                <td className="py-3">{line.description}</td>
                <td className="py-3 pl-4 text-right whitespace-nowrap tabular-nums">
                  {formatKobo(line.amountKobo)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" className="pt-3 text-left font-normal text-muted-foreground">
                Subtotal
              </th>
              <td className="pt-3 pl-4 text-right whitespace-nowrap tabular-nums">
                {formatKobo(invoice.subtotalKobo)}
              </td>
            </tr>
            <tr>
              <th scope="row" className="pt-1.5 text-left font-normal text-muted-foreground">
                VAT ({vatPercent(invoice.vatBps)})
              </th>
              <td className="pt-1.5 pl-4 text-right whitespace-nowrap tabular-nums">
                {formatKobo(invoice.vatKobo)}
              </td>
            </tr>
            <tr className="text-base">
              <th scope="row" className="pt-3 text-left font-semibold">
                Total
              </th>
              <td
                data-invoice-total
                className="pt-3 pl-4 text-right font-bold whitespace-nowrap tabular-nums"
              >
                {formatKobo(invoice.totalKobo)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <section aria-labelledby="payment-heading" className="mt-8 text-sm/6">
        <h2 id="payment-heading" className={LABEL}>
          Payment
        </h2>
        <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Amount paid</dt>
            <dd className="tabular-nums">{formatKobo(invoice.paidKobo)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Method</dt>
            <dd>{invoice.method === 'card' ? 'Card, through Flutterwave' : 'Flutterwave'}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Payment reference</dt>
            <dd className="font-mono text-xs/6 break-all">{invoice.txRef}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Flutterwave transaction</dt>
            <dd className="font-mono text-xs/6 break-all">{invoice.providerReference}</dd>
          </div>
        </dl>
      </section>

      <p className="mt-8 border-t border-border pt-4 text-pretty text-xs/5 text-muted-foreground">
        Amounts are in Nigerian naira, with VAT at {vatPercent(invoice.vatBps)}. Questions about
        this invoice: {BUSINESS.email}.
      </p>
    </article>
  )
}
