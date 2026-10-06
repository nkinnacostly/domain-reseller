import { Prohibit, Scales, ShieldWarning } from '@phosphor-icons/react/ssr'
import type { Metadata } from 'next'
import Link from 'next/link'
import { EmailLink, LegalPage, LegalSection } from '@/features/legal/components/legal-page'
import { SAFETY } from '@/features/marketing/lib/site'
import { pageMetadata } from '@/features/seo/lib/metadata'
import { BUSINESS } from '@/lib/business'

export const metadata: Metadata = pageMetadata({
  title: 'Acceptable Use Policy',
  description:
    'What you may send through MyDomainsHub Mail: transactional email only, to people who gave you their address. No bought lists, phishing, malware or impersonation.',
  path: '/legal/acceptable-use',
})

/**
 * Acceptable Use Policy (MAIL-SPEC §7.7, M1): transactional only in v1; no
 * purchased, rented or scraped lists; no phishing, malware or impersonation;
 * consent is the customer's; breach → pause, then close. A draft until the
 * owner's lawyer has reviewed it.
 */
export default function AcceptableUsePage() {
  return (
    <LegalPage
      path="/legal/acceptable-use"
      title="Acceptable Use Policy"
      icons={[Scales, Prohibit, ShieldWarning]}
      intro={
        <p>
          Every account shares the reputation of the service with every other. This policy says what
          you may send through {BUSINESS.product}, and what happens if you send what you should not.
        </p>
      }
    >
      <LegalSection id="transactional" title="Transactional email only">
        <p>
          For now, {BUSINESS.product} is for transactional email: messages a person expects because
          of something they did or an account they hold with you — receipts, sign-in and
          verification links, password resets, alerts and account notices.
        </p>
        <p>
          Newsletters, promotions and other bulk marketing are not allowed until we offer the tools
          that handle unsubscribes properly.
        </p>
      </LegalSection>

      <LegalSection id="recipients" title="Who you send to">
        <ul>
          <li>
            <strong>No purchased, rented, shared or scraped lists</strong> — not even “opt-in” ones.
          </li>
          <li>Send only to people who gave their address to you, for what you send them.</li>
          <li>
            <strong>Consent is your responsibility.</strong> You must be able to show how each
            address came to you, and stop sending to anyone who asks you to.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="never" title="What you must never send">
        <ul>
          <li>
            Phishing: anything that tries to obtain passwords, card or bank details, or other
            personal data by deception.
          </li>
          <li>Malware, or links to it.</li>
          <li>
            Impersonation: email that pretends to come from another person, business, bank or
            government body, or from a domain you do not control.
          </li>
          <li>Spam, fraud, scams, or anything else unlawful in Nigeria or where it is received.</li>
          <li>Harassment, threats, or content that exploits children.</li>
        </ul>
        <p>
          Nor may you try to get around our limits: opening extra accounts to raise your caps, or
          sending again to addresses on your suppression list by other means.
        </p>
      </LegalSection>

      <LegalSection id="checks" title="What we check">
        <p>
          We refuse executable attachments outright. We may also refuse an email whose sender name
          or domain imitates a bank or a government body, or that links through a URL shortener.
          Anything subtler is for a person to review.
        </p>
      </LegalSection>

      <LegalSection id="rates" title="Bounces and complaints">
        <p>
          High bounce and complaint rates are the clearest sign of a bad list. Over a rolling{' '}
          {SAFETY.windowDays} days, once an account has sent at least {SAFETY.minSends} emails, we
          warn it at {SAFETY.warnBounce} bounces or {SAFETY.warnComplaint} complaints, and pause its
          sending at {SAFETY.pauseBounce} or {SAFETY.pauseComplaint}. Amazon’s own checks run as
          well.
        </p>
      </LegalSection>

      <LegalSection id="breach" title="If this policy is broken">
        <ol>
          <li>
            <strong>We pause the account’s sending</strong>, at once where recipients are at risk,
            and tell its owners why.
          </li>
          <li>
            <strong>We close the account</strong> if the breach is serious, or continues once we
            have told you about it.
          </li>
        </ol>
        <p>
          A person reviews every pause and decides whether sending resumes. We may report illegal
          content to the authorities, and keep what we need to show what happened.
        </p>
      </LegalSection>

      <LegalSection id="report" title="Reporting abuse">
        <p>
          If you received an email sent through us that breaks this policy,{' '}
          <Link href="/abuse">report it</Link> or email <EmailLink />.
        </p>
      </LegalSection>
    </LegalPage>
  )
}
