import { type Contact, formatNaira } from '@dr/shared'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { FormMessage } from '@/components/common/form-parts'
import {
  PANEL_HEADING,
  Panel,
  PanelHeader,
  PanelPage,
  PanelPageSkeleton,
} from '@/components/layout/panel'
import { OrderRefunds } from '@/features/checkout/components/order-refunds'
import { OrderStatus } from '@/features/checkout/components/order-status'
import { RefreshWhile } from '@/features/checkout/components/refresh-while'
import {
  isSettling,
  lineStatus,
  orderKind,
  orderNotice,
  paymentNotice,
} from '@/features/checkout/lib/progress'
import { getOrder, getOrderRefunds } from '@/features/checkout/queries/orders'
import { failureReason } from '@/features/domains/lib/registration'
import { BUSINESS } from '@/lib/business'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Order' }

type Params = Promise<{ id: string }>

const placedFormat = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'long',
  timeZone: 'Africa/Lagos',
})
type Search = Promise<{ payment?: string }>

async function Order({ params, searchParams }: { params: Params; searchParams: Search }) {
  const [{ id }, { payment }] = await Promise.all([params, searchParams])
  const [order, refunds] = await Promise.all([getOrder(id), getOrderRefunds(id)])
  if (!order) notFound()

  const registrant = order.registrant as Contact
  const kind = orderKind(order.order_items)
  const notice = payment ? paymentNotice(payment, kind, BUSINESS.email) : undefined
  // The return from Flutterwave already says a cancelled payment charged nothing.
  const progress =
    notice && order.status === 'cancelled' ? null : orderNotice(order.status, order.test_mode, kind)

  return (
    <>
      <PanelHeader
        crumbs={[
          { label: 'Home', href: '/' },
          { label: 'Dashboard', href: '/app/domains' },
          { label: 'Orders', href: '/app/orders' },
          { label: order.order_number },
        ]}
        title={`Order ${order.order_number}`}
        titleAside={<OrderStatus status={order.status} kind={kind} />}
        description={`Placed ${placedFormat.format(new Date(order.created_at))} · ${formatNaira(Number(order.total_kobo))}${order.test_mode ? ' · test payment' : ''}`}
      >
        {notice || progress ? (
          <div className="max-w-2xl space-y-3">
            {notice ? <FormMessage tone={notice.tone}>{notice.text}</FormMessage> : null}
            {progress ? <FormMessage tone={progress.tone}>{progress.text}</FormMessage> : null}
          </div>
        ) : null}
      </PanelHeader>
      <RefreshWhile active={isSettling(order.status)} />

      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <Panel labelledBy="items-heading">
          <h2 id="items-heading" className={PANEL_HEADING}>
            {kind === 'renew' ? 'Renewal' : 'Domains'}
          </h2>
          <ul className="mt-4 space-y-2">
            {order.order_items.map((item) => (
              <li
                key={item.id}
                className="flex flex-col gap-1 rounded-2xl border border-border bg-background/80 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    {item.status === 'completed' || item.item_type === 'renew' ? (
                      <Link
                        href={`/app/domains/${item.domain}`}
                        className="font-medium break-all text-foreground underline-offset-4 hover:underline"
                      >
                        {item.domain}
                      </Link>
                    ) : (
                      <span className="font-medium break-all text-foreground">{item.domain}</span>
                    )}
                    {order.status !== 'awaiting_payment' && order.status !== 'cancelled' ? (
                      <span
                        data-line-status={item.status}
                        className={cn(
                          'rounded-full px-2 py-0.5 text-xs font-medium text-foreground',
                          item.status === 'failed' ? 'bg-destructive/10' : 'bg-muted',
                        )}
                      >
                        {lineStatus(item.item_type, item.status)}
                      </span>
                    ) : null}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {item.item_type === 'renew' ? 'Renewal · ' : ''}
                    {item.period_years} {item.period_years === 1 ? 'year' : 'years'} · renews at{' '}
                    {formatNaira(Number(item.renewal_kobo))}/yr
                    {item.item_type !== 'renew' && item.auto_renew ? ' · auto-renew on' : ''}
                    {item.item_type !== 'renew' && item.privacy ? ' · privacy on' : ''}
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

          <dl className="mt-5 max-w-sm space-y-2 text-sm sm:ml-auto">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">{kind === 'renew' ? 'Renewal' : 'Domains'}</dt>
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

          <OrderRefunds refunds={refunds} />
        </Panel>

        {kind === 'renew' ? (
          <Panel labelledBy="about-heading" className="h-fit text-sm/6">
            <h2 id="about-heading" className={PANEL_HEADING}>
              About renewals
            </h2>
            <p className="mt-2 text-pretty text-muted-foreground">
              The years are added to the domain’s current expiry date. We call it renewed only once
              the registry shows the new date, and the domain’s page shows it from then on.
            </p>
          </Panel>
        ) : (
          <Panel labelledBy="owner-heading" className="h-fit text-sm/6">
            <h2 id="owner-heading" className={PANEL_HEADING}>
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
                <h2 className="mt-4 font-medium text-foreground">Nameservers</h2>
                <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
                  {order.nameservers.join(', ')}
                </p>
              </>
            ) : null}
          </Panel>
        )}
      </div>
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
    <PanelPage>
      <Suspense fallback={<PanelPageSkeleton />}>
        <Order params={params} searchParams={searchParams} />
      </Suspense>
    </PanelPage>
  )
}
