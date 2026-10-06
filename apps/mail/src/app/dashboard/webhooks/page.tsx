import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import { Container } from '@/components/layout/container'
import { PageSkeleton } from '@/features/accounts/components/dashboard-skeleton'
import { PartError } from '@/features/accounts/components/overview-parts'
import { getCurrentAccount } from '@/features/accounts/queries/accounts'
import { DeliveriesTable } from '@/features/webhooks/components/deliveries-table'
import { WebhookCard } from '@/features/webhooks/components/webhook-card'
import { WebhookForm } from '@/features/webhooks/components/webhook-form'
import { canManageWebhooks } from '@/features/webhooks/lib/words'
import { DELIVERIES_SHOWN, getDeliveries, getWebhooks } from '@/features/webhooks/queries/webhooks'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Webhooks' }

type Params = Promise<{ endpoint?: string }>

const PAGE = '/dashboard/webhooks'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Webhooks (MAIL-SPEC §6, §10, MR6): the account's endpoints, the events
 * each wants, its signing secret (shown once), and recent deliveries with
 * their answers, ready to resend. Members read; owners, admins and
 * developers change (SQL decides, migration 49).
 */
async function Webhooks({ searchParams }: { searchParams: Params }) {
  const [data, { endpoint }] = await Promise.all([getCurrentAccount(), searchParams])
  if (!data) return null
  const { account, role } = data.current
  const filter = endpoint && UUID.test(endpoint) ? endpoint : null
  const [webhooks, deliveries] = await Promise.all([
    getWebhooks(account.id),
    getDeliveries(account.id, filter),
  ])
  const manage = canManageWebhooks(role)
  const filtered = filter ? webhooks?.find((w) => w.id === filter) : null

  return (
    <div className="space-y-10">
      <section aria-labelledby="endpoints-heading" className="space-y-4">
        <h2 id="endpoints-heading" className="text-lg font-semibold">
          Endpoints
        </h2>
        {!webhooks ? (
          <PartError what="the endpoints" retryHref={PAGE} />
        ) : webhooks.length === 0 ? (
          <p className="max-w-2xl text-pretty text-sm text-muted-foreground">
            No endpoints yet.{' '}
            {manage
              ? 'Add one below to hear about deliveries, bounces and complaints as they happen.'
              : 'An owner, admin or developer of this account can add one.'}
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-3xl border border-border bg-card">
            {webhooks.map((webhook) => (
              <WebhookCard
                key={webhook.id}
                accountId={account.id}
                webhook={webhook}
                canManage={manage}
              />
            ))}
          </ul>
        )}
      </section>

      {manage ? (
        <section aria-labelledby="add-heading" className="max-w-3xl space-y-4">
          <div>
            <h2 id="add-heading" className="text-lg font-semibold">
              Add an endpoint
            </h2>
            <p className="mt-1 text-pretty text-sm text-muted-foreground">
              Its signing secret is shown once, when it is made.
            </p>
          </div>
          <div className="rounded-3xl border border-border bg-card p-5 sm:p-6">
            <WebhookForm accountId={account.id} />
          </div>
        </section>
      ) : null}

      <section aria-labelledby="deliveries-heading" className="space-y-4">
        <div>
          <h2 id="deliveries-heading" className="text-lg font-semibold">
            Recent deliveries
          </h2>
          <p className="mt-1 text-pretty text-sm text-muted-foreground">
            The latest {DELIVERIES_SHOWN}
            {filtered ? ` to ${filtered.url}` : ''}, newest first, in Lagos time.
          </p>
        </div>
        {webhooks && webhooks.length > 1 ? (
          <nav aria-label="Deliveries by endpoint">
            <ul className="flex flex-wrap gap-2">
              {[
                { id: null, label: 'All endpoints' },
                ...webhooks.map((w) => ({ id: w.id, label: w.url })),
              ].map((item) => {
                const current = item.id === filter
                return (
                  <li key={item.id ?? 'all'} className="min-w-0 max-w-full">
                    <Link
                      href={item.id ? `${PAGE}?endpoint=${item.id}` : PAGE}
                      aria-current={current ? 'page' : undefined}
                      className={cn(
                        'inline-flex min-h-11 max-w-full items-center truncate rounded-full border px-4 text-sm transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                        current
                          ? 'border-primary font-semibold underline underline-offset-4'
                          : 'border-border',
                      )}
                    >
                      <span className="truncate">{item.label}</span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </nav>
        ) : null}
        {!deliveries ? (
          <PartError what="the deliveries" retryHref={PAGE} />
        ) : deliveries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing has been sent to an endpoint yet. Each event an endpoint wants appears here as
            it is sent.
          </p>
        ) : (
          <DeliveriesTable
            accountId={account.id}
            deliveries={deliveries}
            webhooks={webhooks ?? []}
            canManage={manage}
          />
        )}
      </section>
    </div>
  )
}

export default function WebhooksPage({ searchParams }: { searchParams: Params }) {
  return (
    <Container className="py-6 sm:py-8">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Webhooks</h1>
      <div className="mt-2 max-w-3xl space-y-2 text-pretty text-sm/6 text-muted-foreground">
        <p>
          We send each event an endpoint wants as an HTTPS POST of JSON, signed the Standard
          Webhooks way: check the <code className="font-mono">webhook-signature</code> header with
          the endpoint’s signing secret before you trust a delivery. A delivery that does not get a
          2xx answer is tried again, less often each time, for 24 hours. An endpoint that gets no
          2xx for three days is turned off.
        </p>
      </div>
      <div className="mt-8">
        <Suspense fallback={<PageSkeleton />}>
          <Webhooks searchParams={searchParams} />
        </Suspense>
      </div>
    </Container>
  )
}
