import Link from 'next/link'
import { StatusPill } from '@/components/common/status-pill'
import type { InvoiceSummary } from '../lib/invoice'
import { formatKobo } from '../lib/money'
import { formatDay, formatPeriod } from '../lib/words'
import { linkClass } from './styles'

/** The account's tax invoices, newest first; each opens as a printable page. */
export function InvoiceList({ invoices }: { invoices: InvoiceSummary[] }) {
  if (invoices.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-border px-4 py-3 text-pretty text-sm/6 text-muted-foreground">
        No invoices yet. Every payment gets a tax invoice here, with our CAC number and TIN.
      </p>
    )
  }
  return (
    // S5: the table scrolls in its own box; `relative` keeps sr-only text inside it.
    <div className="relative overflow-x-auto">
      <table className="w-full min-w-[36rem] text-left text-sm">
        <caption className="sr-only">Invoices, newest first</caption>
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground">
            <th scope="col" className="py-2 pr-4 font-medium">
              Invoice
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              Date
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              For
            </th>
            <th scope="col" className="py-2 text-right font-medium">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((invoice) => (
            <tr
              key={invoice.id}
              data-invoice={invoice.number}
              className="border-b border-border align-top"
            >
              <td className="py-3 pr-4">
                <Link
                  href={`/dashboard/billing/invoices/${invoice.id}`}
                  className={`${linkClass} tabular-nums`}
                >
                  {invoice.number}
                </Link>
                {invoice.testMode ? (
                  <StatusPill tone="neutral" className="ml-2">
                    Test
                  </StatusPill>
                ) : null}
              </td>
              <td className="py-3 pr-4 whitespace-nowrap">{formatDay(invoice.issuedAt)}</td>
              <td className="py-3 pr-4">
                {invoice.planName} plan, {formatPeriod(invoice.periodStart, invoice.periodEnd)}
              </td>
              <td className="py-3 text-right font-medium whitespace-nowrap tabular-nums">
                {formatKobo(invoice.totalKobo)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
