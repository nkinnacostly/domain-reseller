import { verified } from './flutterwave-mock'

/**
 * Flutterwave's answers in the live test-mode run of 7 Oct 2026 (MAIL-SPEC
 * §8; migration 56), as fixtures. One checkout charge, 10534506 at 00:54:09
 * UTC, started two subscriptions for one customer and plan — 53194 at
 * 00:54:15 and 53195 at 00:57:09 — and both renewed an hour later on the
 * first charge's tx_ref: 10534534 at 01:54:15 and 10534536 at 01:57:10.
 * `GET /v3/subscriptions?transaction_id=10534506` listed both; a bogus id
 * listed none. The run's reference was RENEWTEST-1791334374 on an hourly
 * plan; Mail's references are `MDM-<checkout>`, so these carry one, and the
 * amount is Starter's ₦21,500. The customer is made up.
 */

export const FIRST_CHARGE = '10534506'
export const KEPT = 53194
export const DUPLICATE = 53195
export const RENEWAL = 10534534
export const SECOND_RENEWAL = 10534536
export const DUPLICATE_TX_REF = 'MDM-7d3c1e2a-4b5f-4c6d-8e9f-0a1b2c3d4e5f'

const subscription = (id: number, createdAt: string, status = 'active') => ({
  id,
  amount: 21500,
  customer: { id: 2399411, customer_email: 'someone@example.com' },
  plan: 150321,
  status,
  created_at: createdAt,
})

/** `GET /subscriptions?transaction_id=10534506`, newest first as Flutterwave lists them. */
export function subscriptionsOfFirstCharge(statuses: { kept?: string; duplicate?: string } = {}) {
  return {
    body: {
      status: 'success',
      message: 'Plan subscriptions fetched',
      meta: { page_info: { total: 2, current_page: 1, total_pages: 1 } },
      data: [
        subscription(DUPLICATE, '2026-10-07T00:57:09.000Z', statuses.duplicate),
        subscription(KEPT, '2026-10-07T00:54:15.000Z', statuses.kept),
      ],
    },
  }
}

/** A bogus transaction id: Flutterwave lists nothing. */
export const NO_SUBSCRIPTIONS = {
  body: {
    status: 'success',
    message: 'Plan subscriptions fetched',
    meta: { page_info: { total: 0, current_page: 1, total_pages: 0 } },
    data: [],
  },
}

/** `PUT /subscriptions/:id/cancel`, as Flutterwave answers a cancel it made. */
export const cancelled = (id: number) => ({
  body: {
    status: 'success',
    message: 'Subscription cancelled',
    data: { ...subscription(id, '2026-10-07T00:54:15.000Z'), status: 'cancelled' },
  },
})

/** The two renewals' verify answers. */
export const renewalCharge = (id: number, createdAt: string) =>
  verified(id, { tx_ref: DUPLICATE_TX_REF, created_at: createdAt, plan: 150321 })

export const FIRST_RENEWAL_CHARGE = renewalCharge(RENEWAL, '2026-10-07T01:54:15.000Z')
export const SECOND_RENEWAL_CHARGE = renewalCharge(SECOND_RENEWAL, '2026-10-07T01:57:10.000Z')
