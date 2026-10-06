import type { AccountState } from '@dr/shared/mail'
import type { Tone } from '@/components/common/status-pill'

/**
 * An account's state in words (MAIL-SPEC §7.2, §8, MR5), and the banner the
 * dashboard shows above every page while it needs saying. Colour is never the
 * only signal: every banner has a title and an icon kind (S8).
 */

export const STATE_LABEL: Record<AccountState, { label: string; tone: Tone }> = {
  sandbox: { label: 'Sandbox', tone: 'info' },
  active: { label: 'Active', tone: 'success' },
  paused: { label: 'Paused', tone: 'danger' },
  closed: { label: 'Closed', tone: 'neutral' },
}

export const isAccountState = (value: unknown): value is AccountState =>
  typeof value === 'string' && value in STATE_LABEL

/**
 * §8: a renewal that failed or never came gives days past due before the
 * Free plan (`renewal_failed`); so does a downgrade to a paid plan waiting
 * for its first payment (`payment_needed`). Read from billing (migration 50).
 */
export type BillingStanding = {
  status: 'past_due'
  until: Date
  reason?: 'renewal_failed' | 'payment_needed'
  planName?: string
} | null

export type AccountBanner = {
  kind: 'sandbox' | 'paused' | 'past_due' | 'closed'
  tone: Tone
  title: string
  body: string
}

const dayFormat = new Intl.DateTimeFormat('en-NG', {
  day: 'numeric',
  month: 'long',
  timeZone: 'Africa/Lagos',
})

/**
 * What the account's banner says, or null when there is nothing to say.
 * A pause — ours, or SES's on the tenant (MR5) — outranks the rest: nothing
 * is sent while it lasts. `sandboxDailyCap` is the cap SQL applies (mail.settings),
 * never a number written here (N5b).
 */
export function accountBanner(
  account: { state: AccountState; sesStatus: string },
  billing: BillingStanding,
  sandboxDailyCap: number | null,
): AccountBanner | null {
  if (account.state === 'closed') {
    return {
      kind: 'closed',
      tone: 'neutral',
      title: 'This account is closed',
      body: 'Nothing can be sent from it. Write to hello@mydomainshub.com with any question.',
    }
  }
  if (account.state === 'paused' || account.sesStatus === 'disabled') {
    return {
      kind: 'paused',
      tone: 'danger',
      title: 'Sending is paused',
      body: 'While it is paused the API refuses new emails and queued ones are not sent. Write to hello@mydomainshub.com and a person will look into it with you.',
    }
  }
  if (billing?.status === 'past_due') {
    const until = dayFormat.format(billing.until)
    const plan = billing.planName ? `the ${billing.planName} plan` : 'your plan'
    return billing.reason === 'payment_needed'
      ? {
          kind: 'past_due',
          tone: 'warning',
          title: `${billing.planName ?? 'Your new plan'} needs its first payment`,
          body: `A change of plan needs a new card payment. Sending continues on ${plan}’s caps until ${until}. Pay on the Billing page before then, or the account moves to the Free plan.`,
        }
      : {
          kind: 'past_due',
          tone: 'warning',
          title: 'Your renewal payment has not come through',
          body: `Sending continues until ${until}. Pay on the Billing page before then to keep ${plan}; after that the account moves to the Free plan’s caps.`,
        }
  }
  if (account.state === 'sandbox') {
    const cap = sandboxDailyCap === null ? 'a small daily cap' : `${sandboxDailyCap} a day`
    return {
      kind: 'sandbox',
      tone: 'info',
      title: 'This account is in the sandbox',
      body: `It can send only to its own members’ confirmed addresses, up to ${cap}. It leaves the sandbox once a domain is verified, the profile is complete and our team has approved it.`,
    }
  }
  return null
}
