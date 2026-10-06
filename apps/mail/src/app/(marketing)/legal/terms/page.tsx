import type { Metadata } from 'next'
import Link from 'next/link'
import { EmailLink, LegalPage, LegalSection } from '@/features/legal/components/legal-page'
import { SAFETY } from '@/features/marketing/lib/site'
import { pageMetadata } from '@/features/seo/lib/metadata'
import { BUSINESS } from '@/lib/business'

export const metadata: Metadata = pageMetadata({
  title: 'Terms of Service',
  description:
    'The agreement for using MyDomainsHub Mail: accounts, the sandbox, plans and caps, payment, pausing and closing.',
  path: '/legal/terms',
})

/**
 * Terms of Service (MAIL-SPEC §10, §14.5). A draft until the owner's lawyer
 * has reviewed it. The facts come from the spec: plans and caps (§8), the
 * sandbox (§7.2), pauses (§7.4, MR5), bodies kept 72 hours (MR3).
 */
export default function TermsPage() {
  return (
    <LegalPage
      path="/legal/terms"
      title="Terms of Service"
      intro={
        <p>
          The agreement between you and us when you use {BUSINESS.product}. Please read it with the{' '}
          <Link href="/legal/acceptable-use">Acceptable Use Policy</Link> and the{' '}
          <Link href="/legal/dpa">Data Processing Agreement</Link>, which form part of it.
        </p>
      }
    >
      <LegalSection id="who" title="Who we are">
        <p>
          {BUSINESS.product} is a service of {BUSINESS.operator} ({BUSINESS.rcNumber}, TIN{' '}
          {BUSINESS.tin}), trading as {BUSINESS.brand} (“we”, “us”), at {BUSINESS.site}. These terms
          are the agreement between us and the business or person who opens a Mail account (“you”).
        </p>
      </LegalSection>

      <LegalSection id="service" title="The service">
        <p>
          An API for sending transactional email — receipts, sign-in links, alerts — from domains
          you have verified, through Amazon Simple Email Service, and a record of what happened to
          each email. It does not include newsletters, contact lists, a template editor, SMTP,
          inbound email, dedicated IP addresses, or open and click tracking.
        </p>
      </LegalSection>

      <LegalSection id="account" title="Your account">
        <ul>
          <li>
            Give us accurate details when you sign up — your business name, website, what you will
            send and roughly how much — and keep them up to date.
          </li>
          <li>
            You are responsible for everyone you add to your account, and for what they do with it.
          </li>
          <li>
            Keep your API keys secret. We show a key once and keep only a hash of it, so we cannot
            show it again; revoke any key you think has been exposed.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="sandbox" title="The sandbox and our review">
        <p>
          A new account starts in the sandbox: it can send only to its own members’ confirmed
          addresses, up to {SAFETY.sandboxDailyCap} emails a day, until its domain is verified, its
          profile is complete and we have reviewed and approved it. We decide whether to approve an
          account. After approval, an account’s daily cap starts lower than its plan’s and rises
          each day its bounce and complaint rates stay low, up to the plan’s cap.
        </p>
      </LegalSection>

      <LegalSection id="plans" title="Plans, caps and prices">
        <ul>
          <li>
            Each plan has the monthly and daily caps, sending domains, team members and log
            retention shown on the <Link href="/pricing">pricing page</Link>. Caps count recipients:
            an email to three people counts as three.
          </li>
          <li>
            At a cap, the API refuses further emails until the cap resets. There is no overage
            billing.
          </li>
          <li>
            Prices are in naira, for a month, before VAT. VAT is added at checkout at the rate in
            force, currently {BUSINESS.vatRate}.
          </li>
          <li>Paid plans are charged monthly, in advance, by card through Flutterwave.</li>
        </ul>
      </LegalSection>

      <LegalSection id="changes-refunds" title="Renewals, plan changes and refunds">
        <ul>
          <li>
            If a monthly payment fails, your account keeps its plan for 7 days while we tell you,
            then moves to the Free plan’s caps until you pay.
          </li>
          <li>
            An upgrade takes effect at once, with the price adjusted for the rest of the month. A
            downgrade or a cancellation takes effect at the end of the month you have paid for.
          </li>
          <li>We do not refund part of a month, unless the service failed because of us.</li>
        </ul>
      </LegalSection>

      <LegalSection id="content" title="What you send">
        <p>
          You may send only what the <Link href="/legal/acceptable-use">Acceptable Use Policy</Link>{' '}
          allows. You are responsible for the content of your emails and for having your recipients’
          consent to receive them.
        </p>
      </LegalSection>

      <LegalSection id="pausing" title="Pausing and closing an account">
        <p>
          We may pause an account’s sending at once if it breaks the Acceptable Use Policy, if its
          bounce or complaint rates pass our limits, or if Amazon pauses it. A person reviews every
          pause before sending resumes. We may close an account for a serious or repeated breach.
          You may close your account at any time by emailing <EmailLink />.
        </p>
      </LegalSection>

      <LegalSection id="data" title="Your recipients’ data">
        <p>
          We process the personal data in your emails on your behalf, under the{' '}
          <Link href="/legal/dpa">Data Processing Agreement</Link>. Message bodies are deleted 72
          hours after sending; the email log is kept for your plan’s retention. Our{' '}
          <Link href="/legal/privacy">Privacy Notice</Link> explains the rest.
        </p>
      </LegalSection>

      <LegalSection id="availability" title="Availability">
        <p>
          We work to keep the service running, but we do not promise it will be uninterrupted. We
          cannot promise that a receiving mail provider will accept or deliver any email.
        </p>
      </LegalSection>

      <LegalSection id="liability" title="Liability">
        <p>
          As far as the law allows, we are not liable for indirect or consequential loss, and our
          total liability to you in any month is limited to what you paid us for that month.
        </p>
      </LegalSection>

      <LegalSection id="changes" title="Changes to these terms">
        <p>
          When we change these terms, we will email account owners before the change takes effect.
          The date at the top shows the current version.
        </p>
      </LegalSection>

      <LegalSection id="law" title="Governing law">
        <p>These terms are governed by the laws of the Federal Republic of Nigeria.</p>
      </LegalSection>

      <LegalSection id="contact" title="Contact">
        <p>
          Email <EmailLink />.
        </p>
      </LegalSection>
    </LegalPage>
  )
}
