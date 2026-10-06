import Link from 'next/link'
import { FormMessage } from '@/components/common/form-parts'
import { Container } from '@/components/layout/container'
import { PartError, UsageMeter } from '@/features/accounts/components/overview-parts'
import { formatCount, meter } from '@/features/accounts/lib/usage'
import type { CurrentAccount } from '@/features/accounts/queries/accounts'
import { getUsage } from '@/features/accounts/queries/overview'
import { capsText, optionCopy, priceText } from '../lib/plan-copy'
import { returnNotice } from '../lib/words'
import { getBillingOverview, listInvoices } from '../queries/billing'
import { paymentsConfigured } from '../server/env'
import { CurrentPlan } from './current-plan'
import { InvoiceList } from './invoice-list'
import { PlanOptions } from './plan-options'
import { cardClass, linkClass } from './styles'

const RETRY = '/dashboard/billing'

/**
 * Billing (MAIL-SPEC §8, §10): the plan and its period, this month's use of
 * its caps (read-only — the 80% and 100% notices are trust and safety's),
 * changing plan, and the tax invoices. Every amount is SQL's (migration 50).
 * Each part loads, fails and says so on its own (S11).
 */
export async function BillingPage({
  data,
  payment,
}: {
  data: CurrentAccount
  payment: string | undefined
}) {
  const { account, role } = data.current
  const manager = role === 'owner' || role === 'admin'
  const [overview, usage, invoices] = await Promise.all([
    getBillingOverview(account.id),
    getUsage(account.id),
    manager ? listInvoices(account.id) : Promise.resolve(null),
  ])
  const onSale = paymentsConfigured()
  const open = account.state !== 'paused' && account.state !== 'closed'
  const canAct = manager && onSale && open
  const notice = returnNotice(payment)

  return (
    <Container className="space-y-6 py-6 sm:py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Billing</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Plans are monthly, in naira, paid by card through Flutterwave.
        </p>
      </div>

      {notice ? (
        <FormMessage tone={notice.tone}>
          <p data-payment-notice={payment}>{notice.text}</p>
        </FormMessage>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[3fr_2fr]">
        {overview ? (
          <CurrentPlan accountId={account.id} overview={overview} canAct={canAct} />
        ) : (
          <div className={cardClass}>
            <PartError what="your plan" retryHref={RETRY} />
          </div>
        )}

        <section aria-labelledby="usage-heading" className={cardClass}>
          <h2 id="usage-heading" className="font-semibold">
            This month’s use
          </h2>
          {usage ? (
            <div className="mt-4 space-y-5">
              <UsageMeter
                label="This month"
                meter={meter(usage.month.queued, usage.caps.monthly)}
              />
              <UsageMeter label="Today" meter={meter(usage.today.queued, usage.caps.daily)} />
              <p className="text-pretty text-xs/5 text-muted-foreground">
                The caps that apply today: {formatCount(usage.caps.monthly)} a month and{' '}
                {formatCount(usage.caps.daily)} a day, counted in recipients on Lagos time. There is
                no overage: at a cap, new emails are refused until it resets.{' '}
                <Link href="/dashboard" className={linkClass}>
                  See the overview
                </Link>
              </p>
            </div>
          ) : (
            <div className="mt-4">
              <PartError what="this month’s use" retryHref={RETRY} />
            </div>
          )}
        </section>
      </div>

      <section aria-labelledby="change-heading" className="space-y-4">
        <div>
          <h2 id="change-heading" className="text-lg font-semibold">
            Change plan
          </h2>
          <p className="mt-1 text-pretty text-sm text-muted-foreground">
            A bigger plan starts at once; a smaller plan or Free waits for the end of the month you
            have paid for. Part-months are not refunded.
          </p>
        </div>
        {!onSale ? (
          <p className="rounded-2xl border border-dashed border-border px-4 py-3 text-pretty text-sm/6 text-muted-foreground">
            Paid plans are not on sale yet. This account stays on its current plan.
          </p>
        ) : !manager ? (
          <p className="rounded-2xl border border-dashed border-border px-4 py-3 text-pretty text-sm/6 text-muted-foreground">
            Only the account’s owner or an admin can change its plan or see its invoices.
          </p>
        ) : !open ? (
          <p className="rounded-2xl border border-dashed border-border px-4 py-3 text-pretty text-sm/6 text-muted-foreground">
            This account is {account.state}, so its plan cannot change now. Write to
            hello@mydomainshub.com.
          </p>
        ) : null}
        {overview ? (
          <PlanOptions
            accountId={account.id}
            canAct={canAct}
            plans={overview.plans.map((option) => ({
              code: option.code,
              name: option.name,
              price: priceText(option),
              caps: capsText(option),
              // Not on sale: the price and caps only, never the terms of a sale that cannot happen (N9b).
              copy: onSale
                ? optionCopy(option, overview)
                : { ...optionCopy(option, overview), lines: [], action: { kind: 'none' } },
            }))}
          />
        ) : (
          <PartError what="the plans" retryHref={RETRY} />
        )}
      </section>

      {manager ? (
        <section aria-labelledby="invoices-heading" className={cardClass}>
          <h2 id="invoices-heading" className="font-semibold">
            Invoices
          </h2>
          <div className="mt-4">
            {invoices ? (
              <InvoiceList invoices={invoices} />
            ) : (
              <PartError what="the invoices" retryHref={RETRY} />
            )}
          </div>
        </section>
      ) : null}
    </Container>
  )
}
