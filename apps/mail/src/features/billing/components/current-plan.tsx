import { CreditCard } from 'lucide-react'
import { StatusPill, type Tone } from '@/components/common/status-pill'
import { formatKobo, vatPercent } from '../lib/money'
import { type BillingOverview, liveSubscription } from '../lib/overview'
import { cardText, formatDay, formatPeriod } from '../lib/words'
import { KeepPlanButton } from './keep-plan-button'
import { cardClass } from './styles'

/**
 * The plan this account is on (MAIL-SPEC §8, §10): its price with VAT, the
 * period paid for, what happens at its end, and the card on file by its last
 * four digits only — for those who manage billing.
 */
export function CurrentPlan({
  accountId,
  overview,
  canAct,
}: {
  accountId: string
  overview: BillingOverview
  canAct: boolean
}) {
  const live = liveSubscription(overview)
  const ended = overview.subscription?.status === 'ended' ? overview.subscription : null
  const planName = live?.planName ?? overview.plan?.name ?? 'Free'
  const status: { tone: Tone; label: string } = !live
    ? { tone: 'neutral', label: 'No card payments' }
    : live.status === 'past_due'
      ? { tone: 'warning', label: 'Past due' }
      : live.scheduledPlanCode
        ? { tone: 'info', label: 'Change scheduled' }
        : { tone: 'success', label: 'Active' }

  return (
    <section aria-labelledby="plan-heading" className={cardClass}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="plan-heading" className="text-sm font-medium text-muted-foreground">
            Your plan
          </h2>
          <p data-current-plan className="mt-1 text-2xl font-semibold tracking-tight">
            {planName}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusPill tone={status.tone}>{status.label}</StatusPill>
          {live?.testMode ? <StatusPill tone="neutral">Test payments</StatusPill> : null}
        </div>
      </div>

      <div className="mt-4 space-y-2 text-pretty text-sm/6">
        {live ? (
          <p>
            {formatKobo(live.amountKobo)} a month: {formatKobo(live.priceKobo)} plus{' '}
            {vatPercent(live.vatBps)} VAT, charged to your card by Flutterwave.
          </p>
        ) : null}

        {live?.status === 'active' && !live.scheduledPlanCode ? (
          <p>
            Paid for {formatPeriod(live.currentPeriodStart, live.currentPeriodEnd)}. Flutterwave
            charges the next month on about {formatDay(live.currentPeriodEnd)}.
          </p>
        ) : null}

        {live?.status === 'active' && live.scheduledPlanCode ? (
          <p>
            Paid for {formatPeriod(live.currentPeriodStart, live.currentPeriodEnd)}. Card charges
            for it have stopped. On {formatDay(live.currentPeriodEnd)} the account moves to the{' '}
            {live.scheduledPlanName ?? live.scheduledPlanCode} plan
            {live.scheduledPlanCode === 'free'
              ? '.'
              : ', which needs a new card payment, made on this page.'}
          </p>
        ) : null}

        {live?.status === 'past_due' && live.pastDueUntil ? (
          live.pastDueReason === 'payment_needed' ? (
            <p>
              A change of plan needs a new card payment. Sending continues on {live.planName}’s caps
              until {formatDay(live.pastDueUntil)}. Pay below before then, or the account moves to
              the Free plan.
            </p>
          ) : (
            <p>
              The renewal payment due on {formatDay(live.currentPeriodEnd)} has not come through.
              Sending continues until {formatDay(live.pastDueUntil)}. Pay below before then to keep{' '}
              {live.planName}; after that the account moves to the Free plan’s caps.
            </p>
          )
        ) : null}

        {!live ? (
          <p className="text-muted-foreground">
            {ended
              ? `The ${ended.planName} plan ended ${ended.endedReason === 'lapsed' ? 'after its payment was past due' : 'at the end of its period'}. `
              : ''}
            Nothing is charged on this plan. Its caps are below; a paid plan raises them.
          </p>
        ) : null}

        {overview.canManage && live?.card ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <CreditCard className="size-4 shrink-0" aria-hidden="true" />
            <span>Card on file: {cardText(live.card)}</span>
          </p>
        ) : null}
      </div>

      {canAct && live?.status === 'active' && live.scheduledPlanCode ? (
        <div className="mt-4">
          <KeepPlanButton accountId={accountId} planName={live.planName} />
        </div>
      ) : null}
    </section>
  )
}
