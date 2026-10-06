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

/** §8: a failed renewal gives seven days past due. Billing arrives with its own package. */
export type BillingStanding = { status: 'past_due'; until: Date } | null

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
    return {
      kind: 'past_due',
      tone: 'warning',
      title: 'Your last payment failed',
      body: `Sending continues until ${dayFormat.format(billing.until)}. After that the account drops to the Free plan’s caps until a payment goes through.`,
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
