import { describe, expect, it } from 'vitest'
import { accountBanner } from '@/features/accounts/lib/state'
import {
  hasMorePages,
  isStopped,
  oldestFirst,
  planObjectName,
  readCharge,
  readSubscriptions,
  readWebhook,
} from '../lib/flutterwave'
import { readInvoice, readInvoiceSummary } from '../lib/invoice'
import { formatKobo, vatPercent } from '../lib/money'
import { liveSubscription, readBillingOverview } from '../lib/overview'
import { capsText, optionCopy, priceText } from '../lib/plan-copy'
import { billingStanding } from '../lib/standing'
import {
  BILLING_FALLBACK,
  cardText,
  formatDay,
  formatPeriod,
  refusalMessage,
  returnNotice,
} from '../lib/words'
import { freeOverview, INVOICE_ROW, planRow, starterOverview, subscription } from './fixtures'

/** Billing's pure parts (MAIL-SPEC §8; migration 50's answers). */

describe('money at the display edge (N5)', () => {
  it('shows whole naira plainly and kobo only when there are some', () => {
    expect(formatKobo(2_150_000)).toBe('₦21,500')
    expect(formatKobo(4_479_167)).toBe('₦44,791.67')
    expect(formatKobo(-1_333_333)).toBe('−₦13,333.33')
    expect(formatKobo(0)).toBe('₦0')
    expect(vatPercent(750)).toBe('7.5%')
  })

  it('refuses an amount that is not whole kobo', () => {
    expect(() => formatKobo(1.5)).toThrow(RangeError)
  })
})

describe('reading billing_overview', () => {
  it('reads a Free account and a paid one', () => {
    const free = readBillingOverview(freeOverview())
    expect(free).toMatchObject({ role: 'owner', canManage: true, vatBps: 750, subscription: null })
    expect(free?.plans.map((p) => p.quote.change)).toEqual(['current', 'subscribe', 'subscribe'])
    const paid = readBillingOverview(starterOverview())
    expect(paid?.subscription).toMatchObject({
      status: 'active',
      planName: 'Starter',
      card: { last4: '4242', brand: 'VISA' },
    })
    expect(paid?.subscription?.currentPeriodEnd.toISOString()).toBe('2026-11-06T10:00:00.000Z')
    expect(paid && liveSubscription(paid)?.planCode).toBe('starter')
  })

  it('answers null for anything it cannot trust, never a guessed price', () => {
    expect(readBillingOverview(null)).toBeNull()
    expect(readBillingOverview({ ok: false, code: 'not_found' })).toBeNull()
    expect(readBillingOverview({ ...freeOverview(), role: 'king' })).toBeNull()
    expect(readBillingOverview({ ...freeOverview(), plans: 'none' })).toBeNull()
    const badPlan = freeOverview()
    ;(badPlan.plans[1] as { quote: Record<string, unknown> }).quote.totalKobo = 21.5
    expect(readBillingOverview(badPlan)).toBeNull()
    expect(
      readBillingOverview({ ...freeOverview(), subscription: subscription({ status: 'odd' }) }),
    ).toBeNull()
    expect(
      readBillingOverview({
        ...freeOverview(),
        subscription: subscription({ priceKobo: '20000' }),
      }),
    ).toBeNull()
  })

  it('drops a card that is not four digits, and an ended subscription is not live', () => {
    const odd = readBillingOverview(
      starterOverview({ subscription: subscription({ card: { last4: '42424', brand: 'VISA' } }) }),
    )
    expect(odd?.subscription?.card).toBeNull()
    const ended = readBillingOverview(
      freeOverview({ subscription: subscription({ status: 'ended', endedReason: 'lapsed' }) }),
    )
    expect(ended && liveSubscription(ended)).toBeNull()
    expect(ended?.subscription?.endedReason).toBe('lapsed')
  })
})

describe('what choosing a plan does, in words (N9b)', () => {
  const free = readBillingOverview(freeOverview())
  const paid = readBillingOverview(starterOverview())
  if (!free || !paid) throw new Error('fixtures')

  it('prices with VAT named, and caps from the row', () => {
    expect(priceText(free.plans[1] as never)).toBe('₦20,000 a month + 7.5% VAT')
    expect(priceText(free.plans[0] as never)).toBe('Free')
    expect(capsText(free.plans[1] as never)).toEqual([
      '50,000 emails a month, 5,000 a day',
      '5 domains, 3 members',
      'Email log kept 30 days',
    ])
    expect(capsText(free.plans[0] as never)[1]).toBe('1 domain, 1 member')
  })

  it('subscribing: the total now, then the monthly charge until cancelled', () => {
    const copy = optionCopy(free.plans[1] as never, free)
    expect(copy.action).toEqual({
      kind: 'checkout',
      label: 'Pay ₦21,500 and start Starter',
      totalKobo: 2_150_000,
    })
    expect(copy.lines.join(' ')).toContain('₦21,500 now: ₦20,000 plus 7.5% VAT (₦1,500)')
    expect(copy.lines.join(' ')).toContain('Then ₦21,500 a month')
    expect(optionCopy(free.plans[0] as never, free)).toMatchObject({
      badge: 'Your plan',
      action: { kind: 'none' },
    })
  })

  it('upgrading: at once, the credit shown, and the billing date moving', () => {
    const copy = optionCopy(paid.plans[2] as never, paid)
    expect(copy.action).toMatchObject({ kind: 'checkout', totalKobo: 4_479_167 })
    expect(copy.action.kind === 'checkout' && copy.action.label).toBe(
      'Pay ₦44,791.67 and move to Pro now',
    )
    const words = copy.lines.join(' ')
    expect(words).toContain('less ₦13,333.33 for the unused part of your Starter month')
    expect(words).toContain('Your billing date moves to the day you pay')
  })

  it('cancelling: the plan stays to the period’s end, with no refund', () => {
    const copy = optionCopy(paid.plans[0] as never, paid)
    expect(copy.action).toMatchObject({
      kind: 'schedule',
      label: 'Cancel and move to Free on 6 November 2026',
    })
    expect(copy.lines[0]).toContain('The rest of the month is not refunded')
  })

  it('a smaller paid plan: said plainly that it needs a new card payment', () => {
    const pro = readBillingOverview(
      starterOverview({
        subscription: subscription({
          planCode: 'pro',
          planName: 'Pro',
          priceKobo: 5_500_000,
          amountKobo: 5_912_500,
        }),
        plans: [
          planRow('free', 'cancel'),
          planRow('starter', 'downgrade'),
          planRow('pro', 'current'),
        ],
      }),
    )
    if (!pro) throw new Error('fixture')
    const copy = optionCopy(pro.plans[1] as never, pro)
    expect(copy.action).toMatchObject({
      kind: 'schedule',
      label: 'Move to Starter on 6 November 2026',
    })
    const words = copy.lines.join(' ')
    expect(words).toContain('Pro stays until 6 November 2026, and its card charges stop now')
    expect(words).toContain('needs a new card payment of ₦21,500 a month')
    expect(words).toContain('caps apply for 7 days, then the Free plan’s')
    expect(optionCopy(pro.plans[2] as never, pro).lines).toEqual([])
  })

  it('past due: pay any plan, and Free comes by itself', () => {
    const due = readBillingOverview(
      starterOverview({
        subscription: subscription({
          status: 'past_due',
          pastDueReason: 'renewal_failed',
          pastDueSince: '2026-11-06T10:00:00Z',
          pastDueUntil: '2026-11-13T10:00:00Z',
        }),
        plans: [planRow('free', 'none'), planRow('starter', 'pay'), planRow('pro', 'pay')],
      }),
    )
    if (!due) throw new Error('fixture')
    expect(optionCopy(due.plans[1] as never, due)).toMatchObject({
      badge: 'Payment due',
      action: { kind: 'checkout', label: 'Pay ₦21,500 for Starter' },
    })
    expect(optionCopy(due.plans[2] as never, due).badge).toBeNull()
    // Migration 54 (review 23): the paid month runs on from the last, not from the day of paying.
    expect(optionCopy(due.plans[1] as never, due).lines[0]).toMatch(
      /runs for a month from .+, where your last paid month ends, not from the day you pay\.$/,
    )
    expect(optionCopy(due.plans[0] as never, due).lines[0]).toContain(
      'moves here by itself on 13 November 2026',
    )
    expect(billingStanding(due)).toEqual({
      status: 'past_due',
      until: new Date('2026-11-13T10:00:00Z'),
      reason: 'renewal_failed',
      planName: 'Starter',
    })
    expect(billingStanding(paid)).toBeNull()
    expect(billingStanding(null)).toBeNull()
  })
})

describe('the banner for a past-due account (§8)', () => {
  const base = { state: 'active' as const, sesStatus: 'enabled' }
  const until = new Date('2026-11-13T10:00:00Z')

  it('a renewal that has not come: sending continues, pay on Billing, then Free', () => {
    const banner = accountBanner(
      base,
      { status: 'past_due', until, reason: 'renewal_failed', planName: 'Pro' },
      null,
    )
    expect(banner?.title).toBe('Your renewal payment has not come through')
    expect(banner?.body).toContain('Sending continues until 13 November')
    expect(banner?.body).toContain('to keep the Pro plan')
    expect(banner?.body).not.toMatch(/email/i)
  })

  it('a downgrade waiting for its first payment says so', () => {
    const banner = accountBanner(
      base,
      { status: 'past_due', until, reason: 'payment_needed', planName: 'Starter' },
      null,
    )
    expect(banner?.title).toBe('Starter needs its first payment')
    expect(banner?.body).toContain('A change of plan needs a new card payment')
  })
})

describe('words', () => {
  it('words every refusal, and falls back for an unknown one', () => {
    expect(refusalMessage('quote_changed')).toContain('The price changed')
    expect(refusalMessage('forbidden')).toContain('owner or an admin')
    expect(refusalMessage('nope')).toBe(BILLING_FALLBACK)
    expect(refusalMessage(undefined)).toBe(BILLING_FALLBACK)
  })

  it('words a return from Flutterwave, and ignores anything else', () => {
    expect(returnNotice('paid')?.tone).toBe('success')
    expect(returnNotice('cancelled')?.text).toContain('You have not been charged')
    expect(returnNotice('<script>')).toBeNull()
    expect(returnNotice(undefined)).toBeNull()
  })

  it('dates on Lagos’s calendar, and the card by its last four only', () => {
    expect(formatDay('2026-10-31T23:30:00Z')).toBe('1 November 2026')
    expect(formatPeriod('2026-10-06T10:00:00Z', '2026-11-06T10:00:00Z')).toBe(
      '6 October 2026 – 6 November 2026',
    )
    expect(cardText({ last4: '4242', brand: 'MASTERCARD' })).toBe('Mastercard ending 4242')
    expect(cardText({ last4: '0001', brand: 'ODD' })).toBe('Card ending 0001')
    expect(cardText({ last4: '0001', brand: null })).toBe('Card ending 0001')
  })
})

describe('reading Flutterwave', () => {
  const data = {
    id: 9100001,
    tx_ref: 'MDM-11111111-2222-4333-8444-555555555555',
    flw_ref: 'FLW-1',
    status: 'successful',
    amount: 21500,
    currency: 'NGN',
    payment_type: 'card',
    customer: { email: 'someone@example.com', name: 'Some One' },
    card: { last_4digits: '4242', type: 'visa', token: 'flw-t1nk-secret', first_6digits: '553188' },
  }

  it('keeps the charge’s facts and the card’s last four, never the customer or the token', () => {
    const charge = readCharge(data)
    expect(charge).toMatchObject({
      id: '9100001',
      amountKobo: 2_150_000,
      cardLast4: '4242',
      cardBrand: 'VISA',
      method: 'card',
    })
    expect(JSON.stringify(charge?.record)).not.toMatch(/someone|t1nk|553188/)
    expect(readCharge({ ...data, card: { last_4digits: '42', type: '<b>' } })).toMatchObject({
      cardLast4: null,
      cardBrand: null,
    })
    expect(readCharge({ ...data, id: '9100001' })).toBeNull()
    expect(readCharge({ ...data, amount: Number.NaN })).toBeNull()
    expect(readCharge('nothing')).toBeNull()
  })

  it('orders a first charge’s subscriptions earliest-made first, and spots a listing cut short (7 Oct 2026)', () => {
    const dup = { id: 53195, status: 'active', plan: 1, createdAt: '2026-10-07T00:57:09.000Z' }
    const kept = { id: 53194, status: 'active', plan: 1, createdAt: '2026-10-07T00:54:15.000Z' }
    expect(oldestFirst([dup, kept]).map((s) => s.id)).toEqual([53194, 53195])
    // The same moment, then by id; a missing date anywhere: by id alone.
    const twin = { ...dup, id: 53190, createdAt: kept.createdAt }
    expect(oldestFirst([kept, twin]).map((s) => s.id)).toEqual([53190, 53194])
    expect(
      oldestFirst([
        { ...kept, id: 9 },
        { ...dup, id: 8, createdAt: null },
      ]).map((s) => s.id),
    ).toEqual([8, 9])
    expect(oldestFirst([])).toEqual([])
    expect(hasMorePages({ page_info: { total: 2, current_page: 1, total_pages: 1 } })).toBe(false)
    expect(hasMorePages({ page_info: { total: 25, current_page: 1, total_pages: 2 } })).toBe(true)
    expect(hasMorePages(undefined)).toBe(false)
    expect(hasMorePages({ page_info: 'x' })).toBe(false)
  })

  it('reads subscriptions and webhook hints, dropping odd rows', () => {
    expect(readSubscriptions([{ id: 7, status: 'active', plan: 3 }, { id: 'x' }])).toEqual([
      { id: 7, status: 'active', plan: 3, createdAt: null },
    ])
    expect(
      readSubscriptions([
        { id: 53194, status: 'active', created_at: '2026-10-07T00:54:15.000Z' },
        { id: 53195, status: 'active', created_at: 'yesterday-ish' },
      ]),
    ).toEqual([
      { id: 53194, status: 'active', plan: null, createdAt: '2026-10-07T00:54:15.000Z' },
      { id: 53195, status: 'active', plan: null, createdAt: null },
    ])
    expect(readSubscriptions(null)).toEqual([])
    expect([isStopped('cancelled'), isStopped('deactivated'), isStopped('active')]).toEqual([
      true,
      true,
      false,
    ])
    expect(readWebhook({ event: 'charge.completed', data: { id: 12, tx_ref: 'MDM-x' } })).toEqual({
      event: 'charge.completed',
      transactionId: '12',
      txRef: 'MDM-x',
    })
    expect(readWebhook({ data: { id: 'abc' } })).toEqual({
      event: '',
      transactionId: null,
      txRef: null,
    })
    expect(readWebhook(7).event).toBe('')
    expect(planObjectName('Starter')).toBe('MyDomainsHub Mail Starter, monthly')
  })
})

describe('reading invoices', () => {
  it('reads an invoice as issued', () => {
    const invoice = readInvoice(INVOICE_ROW)
    expect(invoice).toMatchObject({
      number: 'MDM-TEST-INV-000042',
      testMode: true,
      billedTo: { name: 'Acme Ltd', website: 'https://acme.example' },
      totalKobo: 4_479_167,
      method: 'card',
    })
    expect(invoice?.lines).toHaveLength(2)
    expect(readInvoiceSummary(INVOICE_ROW)?.planName).toBe('Pro')
  })

  it('answers null for a row it cannot trust', () => {
    expect(readInvoice({ ...INVOICE_ROW, lines: [] })).toBeNull()
    expect(
      readInvoice({ ...INVOICE_ROW, lines: [{ description: 'x', amountKobo: 1.5 }] }),
    ).toBeNull()
    expect(readInvoice({ ...INVOICE_ROW, billed_to: null })).toBeNull()
    expect(readInvoice({ ...INVOICE_ROW, vat_kobo: '1' })).toBeNull()
    expect(readInvoice({ ...INVOICE_ROW, tx_ref: null })).toBeNull()
    expect(readInvoice({ ...INVOICE_ROW, method: '' })?.method).toBeNull()
    expect(
      readInvoice({ ...INVOICE_ROW, billed_to: { name: 'Acme' } })?.billedTo.website,
    ).toBeNull()
    expect(readInvoiceSummary({ ...INVOICE_ROW, total_kobo: null })).toBeNull()
    expect(readInvoiceSummary(null)).toBeNull()
  })
})
