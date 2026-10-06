/**
 * Billing in words (MAIL-SPEC §8; the shop's UX-7): what happened, why, and
 * what to do next. A code without words of its own gets the fallback, never
 * the raw code. Nothing here promises an email: v1 sends none for billing
 * (owner, 6 Oct 2026), so the banner and this page carry everything (N9b).
 */

export const BILLING_FALLBACK = 'Something went wrong on our end. Nothing was changed. Try again.'

export const NOT_CHARGED = 'You have not been charged.'

const REFUSALS: Record<string, string> = {
  unauthorized: 'Your session has ended. Sign in again to continue.',
  not_found: 'That account was not found, or you are not one of its members.',
  forbidden: 'Only the account’s owner or an admin can change its plan.',
  account_closed: 'This account is closed, so its plan cannot change.',
  account_paused:
    'Sending is paused on this account, so its plan cannot change now. Write to hello@mydomainshub.com.',
  test_mode_e2e_only: 'Test payments are only for test accounts. Nothing was changed.',
  live_mode_not_for_tests: 'A test account cannot pay with live keys. Nothing was changed.',
  mode_mismatch: 'This subscription was paid with the other kind of keys. Nothing was changed.',
  not_offered: 'That plan is not on offer. Choose another.',
  current_plan: 'You are already on that plan.',
  use_schedule: 'A move to a smaller plan waits for the end of your period. Choose it below.',
  use_checkout: 'A move to a bigger plan happens at once, with a payment. Choose it below.',
  provider_active:
    'Flutterwave is still set to charge the card for this plan. Try again in a minute.',
  provider_canceled:
    'Flutterwave has already stopped the card charges for this plan. Try again in a minute.',
  no_flutterwave_plan: `We could not set up the payment with Flutterwave. ${NOT_CHARGED} Try again.`,
  quote_changed: `The price changed since this page loaded. ${NOT_CHARGED} Look at the new total and try again.`,
  too_many_checkouts: `Too many payments were started in the last hour. ${NOT_CHARGED} Try again later.`,
  past_due:
    'The last payment has not come through, so nothing can be scheduled. Pay below, or let the plan lapse to Free.',
  no_subscription: 'This account has no paid plan to change.',
  nothing_scheduled: 'No change is scheduled.',
}

export function refusalMessage(code: unknown): string {
  return (typeof code === 'string' && REFUSALS[code]) || BILLING_FALLBACK
}

/** What the page says when Flutterwave sends someone back (`?payment=`). */
export const RETURN_NOTICES: Record<string, { tone: 'success' | 'error'; text: string }> = {
  paid: {
    tone: 'success',
    text: 'Payment received. Your new plan is on, and its invoice is below.',
  },
  renewed: { tone: 'success', text: 'Payment received. Your plan is renewed.' },
  already: { tone: 'success', text: 'This payment was already recorded. Its invoice is below.' },
  pending: {
    tone: 'error',
    text: 'Flutterwave has not confirmed this payment yet. Reload this page in a minute; nothing is lost if you do not.',
  },
  unverified: {
    tone: 'error',
    text: 'We could not confirm this payment with Flutterwave just now. It is recorded as soon as Flutterwave answers; reload this page in a minute.',
  },
  failed: { tone: 'error', text: 'The payment did not go through. You have not been charged.' },
  cancelled: { tone: 'error', text: 'The payment was cancelled. You have not been charged.' },
  unapplied: {
    tone: 'error',
    text: 'This payment arrived after its price had changed, so it was not applied. We have recorded it and will refund it; write to hello@mydomainshub.com with any question.',
  },
  mismatch: {
    tone: 'error',
    text: 'That payment does not belong to this checkout, so nothing changed. Write to hello@mydomainshub.com if you were charged.',
  },
}

export function returnNotice(value: unknown) {
  return typeof value === 'string' ? (RETURN_NOTICES[value] ?? null) : null
}

const DAY = new Intl.DateTimeFormat('en-NG', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Africa/Lagos',
})

/** A date as people read it, on Lagos's calendar: "6 November 2026". */
export const formatDay = (at: Date | string) =>
  DAY.format(typeof at === 'string' ? new Date(at) : at)

/** "6 October 2026 – 6 November 2026". */
export function formatPeriod(start: Date | string, end: Date | string): string {
  return `${formatDay(start)} – ${formatDay(end)}`
}

const CARD_BRANDS: Record<string, string> = {
  VISA: 'Visa',
  MASTERCARD: 'Mastercard',
  VERVE: 'Verve',
  'AMERICAN EXPRESS': 'American Express',
}

/** "Visa ending 4242": the scheme as it is known, and the last four digits only. */
export function cardText(card: { last4: string; brand: string | null }): string {
  const brand = card.brand ? (CARD_BRANDS[card.brand] ?? 'Card') : 'Card'
  return `${brand} ending ${card.last4}`
}
