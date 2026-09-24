import type { Metadata } from 'next'
import Link from 'next/link'
import { EmailLink, LegalPage, LegalSection } from '@/features/legal/components/legal-page'
import { BUSINESS } from '@/lib/business'

export const metadata: Metadata = {
  title: 'Refund policy',
  description: `When ${BUSINESS.brand} refunds a payment, and why a registered domain cannot be refunded.`,
}

/**
 * Refund policy (FR-PUB4). The timescale is the owner's commitment. Refunds
 * for failed registrations, renewals and transfers, second charges and short
 * payments are automatic (FR-R3, migrations 15–16, 23, 26), back to the
 * payment method used — as this says.
 */
export default function RefundsPage() {
  const days = BUSINESS.refundBusinessDays
  return (
    <LegalPage
      title="Refund policy"
      intro={
        <p>
          A domain registration is final the moment the registry accepts it — registries do not
          refund us, so we cannot refund you. If we cannot register a domain you paid for, you get
          every naira back.
        </p>
      }
    >
      <LegalSection id="refunded" title="When you get a refund">
        <ul>
          <li>
            <strong>The registration could not be completed</strong> — for example someone else
            registered the name moments before, or the registry refused it. Your order shows which
            domain failed and why.
          </li>
          <li>
            <strong>The renewal could not be completed</strong> — the registry refused it. The
            domain keeps its old expiry date, and your order says why.
          </li>
          <li>
            <strong>The transfer could not be completed</strong> — the transfer code was refused, or
            the current registrar or the registry turned the transfer down. The domain stays where
            it was, and your order says why.
          </li>
          <li>
            <strong>You were charged twice</strong> for the same order.
          </li>
        </ul>
        <p>
          You get the <strong>full amount you paid for that domain, VAT included</strong>, back to
          the payment method you used, within <strong>{days} business days</strong>. If only some
          domains in an order fail, only those are refunded; the rest stay registered. Flutterwave’s
          processing fee, added on its payment page, is Flutterwave’s and is not part of the refund.
        </p>
      </LegalSection>

      <LegalSection id="not-refunded" title="When a refund is not possible">
        <ul>
          <li>A domain the registry has registered, including if you change your mind.</li>
          <li>A domain with a spelling mistake — it is registered exactly as it was typed.</li>
          <li>A renewal the registry has accepted.</li>
          <li>A transfer that has completed — the domain is then registered with us.</li>
        </ul>
        <p>
          That is why checkout shows every name in large type and asks you to confirm the spelling
          before you pay.
        </p>
      </LegalSection>

      <LegalSection id="how" title="How to ask">
        <p>
          Refunds for failed registrations, renewals and transfers need no request — if yours has
          not arrived within {days} business days, or you think you were charged twice, email{' '}
          <EmailLink /> with your order number (it starts with “ND-”). You can find it under{' '}
          <Link href="/app/orders">your orders</Link>.
        </p>
      </LegalSection>
    </LegalPage>
  )
}
