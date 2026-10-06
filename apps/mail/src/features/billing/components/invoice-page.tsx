import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { Container } from '@/components/layout/container'
import { PartError } from '@/features/accounts/components/overview-parts'
import { getInvoice } from '../queries/billing'
import { InvoiceDocument } from './invoice-document'
import { PrintButton } from './print-button'
import { linkClass } from './styles'

/**
 * One invoice, as its account's owners and admins may see it (RLS). Anyone
 * else — or an id that is not an invoice — gets the same "not found".
 */
export async function InvoicePage({ id }: { id: string }) {
  const invoice = await getInvoice(id)
  return (
    <Container className="py-6 sm:py-8">
      <div className="max-w-4xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
          <Link
            href="/dashboard/billing"
            className={`${linkClass} inline-flex min-h-11 items-center gap-1.5 text-sm`}
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to Billing
          </Link>
          {invoice ? <PrintButton /> : null}
        </div>
        {invoice === undefined ? (
          <PartError
            what="this invoice"
            retryHref={`/dashboard/billing/invoices/${encodeURIComponent(id)}`}
          />
        ) : invoice === null ? (
          <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-pretty text-sm/6">
            <h1 className="text-lg font-semibold">Invoice not found</h1>
            <p className="mt-1 text-muted-foreground">
              It does not exist, or it belongs to an account whose billing you do not manage.
              Invoices are for the account’s owner and admins.
            </p>
          </div>
        ) : (
          <InvoiceDocument invoice={invoice} />
        )}
      </div>
    </Container>
  )
}
