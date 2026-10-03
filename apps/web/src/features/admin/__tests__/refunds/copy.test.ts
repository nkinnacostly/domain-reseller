import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AdminFlwRefundCheck } from '@dr/shared/admin'
import { describe, expect, it } from 'vitest'
import {
  approveCopy,
  CANCEL_COPY,
  CHECK_STEP,
  checkProblemWords,
  checkSummary,
  eventDetail,
  eventTitle,
  HANDLED_OUTSIDE_CHECK,
  heldBecause,
  INCIDENT_KIND_LABEL,
  INCIDENT_KIND_MEANING,
  NO_MONEY_CHECK,
  naira,
  OUTCOME_LABEL,
  PROVIDER_CHECK,
  RESOLVE_COPY,
  recordCopy,
  refundFor,
  retryCopy,
} from '@/features/admin/lib/refunds-copy'
import { INCIDENT_KINDS, INCIDENT_OUTCOMES } from '@/features/admin/lib/refunds-rules'

/**
 * Every word the refund dialogs say (ADMIN-SPEC §5.2 B3, §8.1). The limits
 * here are deliberately not the database's defaults (₦1,000,000 and
 * ₦5,000,000): a figure written into the copy instead of read from
 * `admin_refund_stats.limits` would show here as the wrong number.
 */

const LIMITS = { singleKobo: 12_345_600, dailyKobo: 98_765_400, delayMinutes: 17 }

describe('naira', () => {
  it('writes whole naira plainly and keeps kobo when there are any', () => {
    expect(naira(1_967_200)).toBe('₦19,672')
    expect(naira(1_967_250)).toBe('₦19,672.50')
    expect(naira(0)).toBe('₦0')
  })
})

describe('why a refund is held, from the limits the database holds', () => {
  it('quotes the per-refund limit', () => {
    expect(heldBecause('OVER_SINGLE_LIMIT', LIMITS, 0)).toBe(
      'Over the ₦123,456 automatic limit per refund',
    )
  })

  it('quotes the daily limit and what went out in 24 hours', () => {
    expect(heldBecause('OVER_DAILY_LIMIT', LIMITS, 4_321_050)).toBe(
      'Over the ₦987,654 daily automatic limit — ₦43,210.50 already sent in the last 24 hours',
    )
  })

  it('says nothing for a code that is not a limit', () => {
    expect(heldBecause('CHARGE_NOT_OURS', LIMITS, 0)).toBeNull()
    expect(heldBecause(null, LIMITS, 0)).toBeNull()
  })

  it('follows the limits: other limits, other words', () => {
    const other = { singleKobo: 50_000_000, dailyKobo: 70_000_000, delayMinutes: 5 }
    expect(heldBecause('OVER_SINGLE_LIMIT', other, 0)).toBe(
      'Over the ₦500,000 automatic limit per refund',
    )
  })
})

describe('the dialogs, word for word', () => {
  it('1. Approve', () => {
    expect(approveCopy(1_967_250)).toEqual({
      title: 'Approve this refund?',
      body: "The worker sends it to the card or account that paid on its next run, after reading the charge back from Flutterwave. It stops if the charge isn't this order's.",
      confirmLabel: 'Approve ₦19,672.50 refund',
      cancelLabel: 'Keep it held',
      success: 'Approved. The worker sends it on its next run.',
    })
  })

  it('2. Retry, with both limits from the database in its warning', () => {
    const copy = retryCopy(1_000_000, LIMITS)
    expect(copy.title).toBe('Send this refund again?')
    expect(copy.body).toBe(
      "Only after checking Flutterwave shows no refund for this charge. The worker reads the charge's refunds before sending.",
    )
    expect(copy.warning).toBe(
      "Retrying approves it: the ₦123,456 per-refund and ₦987,654 daily automatic limits won't hold it again.",
    )
    expect(copy.confirmLabel).toBe('Retry ₦10,000 refund')
    expect(copy.cancelLabel).toBe('Not now')
    expect(PROVIDER_CHECK.label).toBe(
      'I checked the Flutterwave dashboard: no refund of this charge went through.',
    )
  })

  it('3. Cancel', () => {
    expect(CANCEL_COPY.title).toBe('Cancel this refund?')
    expect(CANCEL_COPY.body).toBe(
      "Use this only when we won't send this money back — for example, the customer's bank reversed the charge (a chargeback), so the money returned without us. If we sent it from the Flutterwave dashboard, use Record a Flutterwave refund instead. If the domain turned out to be registered, retry the registration job: that records it and cancels the refund.",
    )
    expect(CANCEL_COPY.noteLabel).toBe('What happened')
    expect(NO_MONEY_CHECK.label).toBe(
      "We haven't returned this money through Flutterwave, and won't.",
    )
    expect(CANCEL_COPY.confirmLabel).toBe('Cancel refund — nothing sent')
    expect(CANCEL_COPY.cancelLabel).toBe('Keep refund')
  })

  it('4. Record a Flutterwave refund', () => {
    const copy = recordCopy(1_967_250)
    expect(copy.body).toBe(
      "Nothing is sent. The customer's order page will show ₦19,672.50 as refunded.",
    )
    expect(copy.confirmLabel).toBe('Record ₦19,672.50 as refunded')
    expect(copy.cancelLabel).toBe('Cancel')
    expect(CHECK_STEP.idLabel).toBe('Flutterwave refund id')
    expect(CHECK_STEP.button).toBe('Check with Flutterwave')
  })

  it('5. Resolve an incident', () => {
    expect(RESOLVE_COPY.title).toBe('Mark this incident resolved?')
    expect(RESOLVE_COPY.reviewed).toBe(
      "This records that you've looked at it. Nothing is charged or refunded.",
    )
    expect(RESOLVE_COPY.confirmLabel).toBe('Mark resolved')
    expect(RESOLVE_COPY.cancelLabel).toBe('Not yet')
    expect(OUTCOME_LABEL).toEqual({
      payment_recorded: 'The payment is now recorded',
      refund_completed: 'A refund for this order completed',
      flw_refund_verified: 'A Flutterwave refund I checked just now',
      handled_outside: 'Handled outside the dashboard',
    })
    expect(HANDLED_OUTSIDE_CHECK.label).toBe(
      'I confirmed in Flutterwave that the customer has their money or their order, and recorded what happened in the SQL editor.',
    )
    for (const outcome of INCIDENT_OUTCOMES) expect(OUTCOME_LABEL[outcome]).toBeTruthy()
  })

  it('names and explains every incident kind the database records', () => {
    for (const kind of INCIDENT_KINDS) {
      expect(INCIDENT_KIND_LABEL[kind], kind).toBeTruthy()
      expect(INCIDENT_KIND_MEANING[kind], kind).toBeTruthy()
    }
  })

  it('writes no naira figure into the copy: every one is built from a number (N9b)', () => {
    // Comments may show an example; the code may not hold one.
    const code = readFileSync(join(__dirname, '../../lib/refunds-copy.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/₦\s?\d/)
    expect(code).not.toMatch(/1,000,000|5,000,000|100_000_000|500_000_000/)
  })
})

describe('a Flutterwave check, in words', () => {
  const check: AdminFlwRefundCheck = {
    checkId: 7,
    flwRefundId: '123',
    transactionId: '456',
    amountKobo: 1_967_250,
    status: 'completed-mpgs',
    state: 'done',
    readAt: '2026-10-03T09:00:00.000Z',
  }

  it('reads as the spec words it when it matches', () => {
    expect(checkSummary(check, true, 'refund')).toBe(
      'Flutterwave refund 123: ₦19,672.50 on charge 456, completed — matches this refund',
    )
    expect(checkSummary({ ...check, transactionId: null, state: 'pending' }, false, 'refund')).toBe(
      'Flutterwave refund 123: ₦19,672.50 on an unknown charge, not finished',
    )
  })

  it('says each mismatch', () => {
    expect(checkProblemWords({ kind: 'amount', checkKobo: 1_000, wantKobo: 2_050 }, 'refund')).toBe(
      "It is for ₦10, not this refund's ₦20.50.",
    )
    expect(checkProblemWords({ kind: 'charge', checkTx: '9', wantTx: '456' }, 'incident')).toBe(
      "It is on charge 9, not this incident's charge 456.",
    )
    expect(checkProblemWords({ kind: 'charge', checkTx: null, wantTx: '456' }, 'incident')).toMatch(
      /didn't say which charge/,
    )
    expect(checkProblemWords({ kind: 'state', state: 'failed', status: 'failed' }, 'refund')).toBe(
      'Flutterwave says this refund failed, so no money went back.',
    )
    expect(
      checkProblemWords({ kind: 'state', state: 'pending', status: 'completed' }, 'refund'),
    ).toBe(
      "Flutterwave hasn't finished this refund yet (completed). Check again once it completes.",
    )
    expect(checkProblemWords({ kind: 'stale' }, 'refund')).toBe(
      'This check is over 15 minutes old. Check again.',
    )
  })
})

describe('what a refund is for, and its timeline', () => {
  it('names the line, or the charge', () => {
    expect(refundFor('registration_failed', { domain: 'example.com', itemType: 'register' })).toBe(
      'Registration of example.com',
    )
    expect(refundFor('ssl_failed', { domain: 'example.com', itemType: 'ssl' })).toBe(
      'Certificate for example.com',
    )
    expect(refundFor('duplicate_charge', null)).toBe('A second charge for one order')
    expect(refundFor('something_new', null)).toBe('something new')
  })

  it("titles an event, with a person's name only when a person acted", () => {
    expect(eventTitle('held', 'system')).toBe('Held for approval')
    expect(eventTitle('approved', 'owner')).toBe('Approved · owner')
    expect(eventTitle('provider_call', 'system')).toBe('Flutterwave called')
    expect(eventTitle('recovered_late', '')).toBe('recovered late')
  })

  it('puts the facts an event carries into words, and nothing else', () => {
    expect(eventDetail({ why: 'over_single_limit', seeded: true })).toBe('over single limit')
    expect(
      eventDetail({
        code: 'FLW_HTTP_400',
        provider_refund_id: 'r-1',
        status: 'failed',
        attempt: 2,
      }),
    ).toBe('code FLW_HTTP_400 · attempt 2 · Flutterwave refund r-1 · status failed')
    expect(eventDetail({ reason: 'registration_failed', amount_kobo: 107_500 })).toBe('₦1,075')
    expect(eventDetail({ note: 'Chargeback settled' })).toBe('“Chargeback settled”')
    expect(eventDetail({ nested: { a: 1 } })).toBeNull()
  })
})
