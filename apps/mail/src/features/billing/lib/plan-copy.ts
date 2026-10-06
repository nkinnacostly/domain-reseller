import { formatKobo, vatPercent } from './money'
import { type BillingOverview, liveSubscription, type PlanOption } from './overview'
import { formatDay } from './words'

/**
 * What choosing a plan does, said before anyone chooses it (MAIL-SPEC §8,
 * N9b). The owner's decisions of 6 Oct 2026 are worded here as the code
 * behaves: an upgrade starts the new plan's month at once and moves the
 * billing date to that day; a move to a smaller paid plan needs a new card
 * payment once the period ends (Flutterwave's payment plans cannot change a
 * subscription's amount); a cancellation keeps the plan to the period's end,
 * with no refund for the rest of it. No email is promised.
 */

const COUNT = new Intl.NumberFormat('en-NG')
const plural = (n: number, one: string, many: string) =>
  `${COUNT.format(n)} ${n === 1 ? one : many}`

/** A plan's price as its card shows it, VAT named (§8: prices are before VAT). */
export function priceText(option: PlanOption): string {
  return option.priceKobo === 0
    ? 'Free'
    : `${formatKobo(option.priceKobo)} a month + ${vatPercent(option.quote.vatBps)} VAT`
}

/** Its caps, from the plans row: caps count recipients, as SES does. */
export function capsText(option: PlanOption): string[] {
  return [
    `${COUNT.format(option.monthlyCap)} emails a month, ${COUNT.format(option.dailyCap)} a day`,
    `${plural(option.maxDomains, 'domain', 'domains')}, ${plural(option.maxMembers, 'member', 'members')}`,
    `Email log kept ${plural(option.logRetentionDays, 'day', 'days')}`,
  ]
}

export type OptionAction =
  | { kind: 'checkout'; label: string; totalKobo: number }
  | {
      kind: 'schedule'
      label: string
      confirm: { title: string; confirmLabel: string; pendingLabel: string }
    }
  | { kind: 'none' }

export type OptionCopy = {
  /** Shown as the plan's state: "Your plan", "Moves here on …". */
  badge: string | null
  lines: string[]
  action: OptionAction
}

export function optionCopy(option: PlanOption, overview: BillingOverview): OptionCopy {
  const { quote } = option
  const live = liveSubscription(overview)
  const vat = vatPercent(quote.vatBps)
  const total = formatKobo(quote.totalKobo)
  const recurring = formatKobo(quote.recurringKobo)
  const monthly = `Then ${recurring} a month (${formatKobo(quote.priceKobo)} plus ${vat} VAT), charged to your card by Flutterwave until you cancel.`

  switch (quote.change) {
    case 'current':
      return {
        badge: 'Your plan',
        lines: live && live.planCode === option.code ? [] : ['The plan this account is on.'],
        action: { kind: 'none' },
      }
    case 'subscribe':
      return {
        badge: null,
        lines: [
          `${total} now: ${formatKobo(quote.subtotalKobo)} plus ${vat} VAT (${formatKobo(quote.vatKobo)}). It starts at once, for a month from the day you pay.`,
          monthly,
        ],
        action: {
          kind: 'checkout',
          label: `Pay ${total} and start ${option.name}`,
          totalKobo: quote.totalKobo,
        },
      }
    case 'upgrade': {
      const from = live?.planName ?? 'current'
      return {
        badge: null,
        lines: [
          `${option.name} starts at once. You pay ${total} now: ${formatKobo(quote.priceKobo)}, less ${formatKobo(quote.creditKobo)} for the unused part of your ${from} month, plus ${vat} VAT (${formatKobo(quote.vatKobo)}).`,
          `Your billing date moves to the day you pay. ${monthly}`,
        ],
        action: {
          kind: 'checkout',
          label: `Pay ${total} and move to ${option.name} now`,
          totalKobo: quote.totalKobo,
        },
      }
    }
    case 'downgrade': {
      const end = live ? formatDay(live.currentPeriodEnd) : 'the end of this period'
      return {
        badge: null,
        lines: [
          `${live?.planName ?? 'Your plan'} stays until ${end}, and its card charges stop now.`,
          `${option.name} then needs a new card payment of ${recurring} a month, made on this page: a change of plan cannot carry the card over. Until it is paid, ${option.name}’s caps apply for ${overview.pastDueDays} days, then the Free plan’s.`,
        ],
        action: {
          kind: 'schedule',
          label: `Move to ${option.name} on ${end}`,
          confirm: {
            title: `Move to ${option.name} on ${end}?`,
            confirmLabel: `Move to ${option.name} on ${end}`,
            pendingLabel: 'Scheduling…',
          },
        },
      }
    }
    case 'cancel': {
      const end = live ? formatDay(live.currentPeriodEnd) : 'the end of this period'
      return {
        badge: null,
        lines: [
          `${live?.planName ?? 'Your plan'} stays until ${end}, and its card charges stop now. The rest of the month is not refunded. Then the account moves to the Free plan.`,
        ],
        action: {
          kind: 'schedule',
          label: `Cancel and move to Free on ${end}`,
          confirm: {
            title: `Cancel ${live?.planName ?? 'your plan'}?`,
            confirmLabel: `Cancel and move to Free on ${end}`,
            pendingLabel: 'Cancelling…',
          },
        },
      }
    }
    case 'pay':
      return {
        badge: live?.planCode === option.code ? 'Payment due' : null,
        lines: [
          `${total} now: ${formatKobo(quote.subtotalKobo)} plus ${vat} VAT. ${option.name} runs for a month from the day you pay.`,
          monthly,
        ],
        action: {
          kind: 'checkout',
          label: `Pay ${total} for ${option.name}`,
          totalKobo: quote.totalKobo,
        },
      }
    default:
      return {
        badge: null,
        lines:
          option.priceKobo === 0 && live?.status === 'past_due' && live.pastDueUntil
            ? [
                `The account moves here by itself on ${formatDay(live.pastDueUntil)} if no payment comes.`,
              ]
            : [],
        action: { kind: 'none' },
      }
  }
}
