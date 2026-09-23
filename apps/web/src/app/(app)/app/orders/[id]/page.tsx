import { type Contact, formatNaira } from '@dr/shared'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { FormMessage } from '@/components/common/form-parts'
import { Container } from '@/components/layout/site-shell'
import { OrderStatus } from '@/features/checkout/components/order-status'
import { RefreshWhile } from '@/features/checkout/components/refresh-while'
import { isSettling, LINE_STATUS, orderNotice } from '@/features/checkout/lib/progress'
import { getOrder } from '@/features/checkout/queries/orders'
import { failureReason } from '@/features/domains/lib/registration'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Order' }

type Params = Promise<{ id: string }>
type Search = Promise<{ payment?: string }>

const PAYMENT_NOTICES: Record<string, { tone: 'success' | 'error'; text: string }> = {
  paid: { tone: 'success', text: 'Payment received — thank you.' },
  cancelled: {
    tone: 'error',
    text: 'Payment cancelled. Nothing was charged. Your domains are still in your cart.',
  },
  failed: {
    tone: 'error',
    text: 'The payment did not go through. Nothing was charged. You can try again from your cart.',
  },
  pending: {
    tone: 'error',
    text: "We're still waiting for Flutterwave to confirm this payment. This page updates when it does — nothing is charged twice.",
  },
  mismatch: {
    tone: 'error',
    text: "That payment doesn't match this order, so it hasn't been applied. Contact support if you were charged.",
  },
}

async function Order({ params, searchParams }: { params: Params; searchParams: Search }) {
  const [{ id }, { payment }] = await Promise.all([params, searchParams])
  const order = await getOrder(id)
  if (!order) notFound()

  const registrant = order.registrant as Contact
  const notice = payment ? PAYMENT_NOTICES[payment] : undefined
  const progress = orderNotice(order.status, order.test_mode)

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          Order {order.order_number}
        </h1>
        <OrderStatus status={order.status} />
      </div>

      <div className="mt-6 max-w-2xl space-y-3">
        {notice ? <FormMessage tone={notice.tone}>{notice.text}</FormMessage> : null}
        {progress ? <FormMessage tone={progress.tone}>{progress.text}</FormMessage> : null}
      </div>
      <RefreshWhile active={isSettling(order.status)} />

      <div className="mt-8 grid gap-8 lg:grid-cols-[1.6fr_1fr]">
        <section aria-labelledby="items-heading">
          <h2 id="items-heading" className="text-lg font-semibold text-foreground">
            Domains
          </h2>
          <ul className="mt-4 divide-y divide-border/70 rounded-2xl border border-border">
            {order.order_items.map((item) => (
              <li
                key={item.id}
                className="flex flex-col gap-1 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    {item.status === 'completed' ? (
                      <Link
                        href={`/app/domains/${item.domain}`}
                        className="font-semibold break-all text-foreground underline-offset-4 hover:underline"
                      >
                        {item.domain}
                      </Link>
                    ) : (
                      <span className="font-semibold break-all text-foreground">{item.domain}</span>
                    )}
                    {order.status !== 'awaiting_payment' && order.status !== 'cancelled' ? (
                      <span
                        data-line-status={item.status}
                        className={cn(
                          'rounded-full px-2 py-0.5 text-xs font-medium text-foreground',
                          item.status === 'failed' ? 'bg-destructive/10' : 'bg-muted',
                        )}
                      >
                        {LINE_STATUS[item.status] ?? item.status}
                      </span>
                    ) : null}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {item.period_years} {item.period_years === 1 ? 'year' : 'years'} · renews at{' '}
                    {formatNaira(Number(item.renewal_kobo))}/yr
                    {item.auto_renew ? ' · auto-renew on' : ''}
                    {item.privacy ? ' · privacy on' : ''}
                  </p>
                  {item.status === 'failed' ? (
                    <p className="mt-1 text-sm text-foreground">
                      {failureReason(item.failure_code)}
                    </p>
                  ) : null}
                </div>
                <p className="font-medium text-foreground tabular-nums">
                  {formatNaira(Number(item.price_kobo))}
                </p>
              </li>
            ))}
          </ul>

          <dl className="mt-4 max-w-sm space-y-2 text-sm sm:ml-auto">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Domains</dt>
              <dd className="tabular-nums">{formatNaira(Number(order.subtotal_kobo))}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">VAT ({Number(order.vat_pct)}%)</dt>
              <dd className="tabular-nums">{formatNaira(Number(order.vat_kobo))}</dd>
            </div>
            <div className="flex justify-between border-border border-t pt-2 font-semibold">
              <dt>Total</dt>
              <dd className="tabular-nums">{formatNaira(Number(order.total_kobo))}</dd>
            </div>
          </dl>
        </section>

        <section
          aria-labelledby="owner-heading"
          className="h-fit rounded-2xl border border-border p-5 text-sm/6"
        >
          <h2 id="owner-heading" className="font-semibold text-foreground">
            Registrant
          </h2>
          <p className="mt-2 text-muted-foreground">
            {registrant.firstName} {registrant.lastName}
            {registrant.company ? `, ${registrant.company}` : ''}
            <br />
            {registrant.email}
            <br />
            {registrant.addressLine1}, {registrant.city}, {registrant.state} {registrant.zipCode},{' '}
            {registrant.country}
          </p>
          {order.nameservers?.length ? (
            <>
              <h2 className="mt-4 font-semibold text-foreground">Nameservers</h2>
              <p className="mt-1 font-mono text-xs text-muted-foreground">
                {order.nameservers.join(', ')}
              </p>
            </>
          ) : null}
        </section>
      </div>

      <Link
        href="/app/orders"
        className="mt-8 inline-block text-sm font-medium text-foreground underline-offset-4 hover:underline"
      >
        All orders
      </Link>
    </>
  )
}

export default function OrderPage({
  params,
  searchParams,
}: {
  params: Params
  searchParams: Search
}) {
  return (
    <Container className="py-10 sm:py-14">
      <Suspense
        fallback={<div aria-hidden="true" className="h-96 animate-pulse rounded-3xl bg-muted" />}
      >
        <Order params={params} searchParams={searchParams} />
      </Suspense>
    </Container>
  )
}
