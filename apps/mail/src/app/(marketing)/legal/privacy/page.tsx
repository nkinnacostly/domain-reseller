import { EnvelopeSimple, LockKey, UserFocus } from '@phosphor-icons/react/ssr'
import type { Metadata } from 'next'
import Link from 'next/link'
import { EmailLink, LegalPage, LegalSection } from '@/features/legal/components/legal-page'
import { pageMetadata } from '@/features/seo/lib/metadata'
import { BUSINESS } from '@/lib/business'

export const metadata: Metadata = pageMetadata({
  title: 'Privacy Notice',
  description:
    'What personal data MyDomainsHub Mail holds about account holders and about the people they email, why, for how long, and your rights under the NDPA.',
  path: '/legal/privacy',
})

const NDPC = 'https://ndpc.gov.ng/'

/**
 * Privacy Notice (MAIL-SPEC §10, §14.5). Two roles: controller for account
 * holders' data, processor for recipients' (MR4). Bodies kept 72 hours then
 * deleted (MR3); the log for the plan's retention. Nothing here may claim
 * more than the code does (N9b). A draft until the lawyer has reviewed it.
 */
export default function PrivacyPage() {
  return (
    <LegalPage
      path="/legal/privacy"
      title="Privacy Notice"
      icons={[LockKey, UserFocus, EnvelopeSimple]}
      intro={
        <p>
          How {BUSINESS.product} handles personal data — yours, if you hold an account, and that of
          the people you email through us — and your rights under the Nigeria Data Protection Act
          2023.
        </p>
      }
    >
      <LegalSection id="roles" title="Our two roles">
        <ul>
          <li>
            <strong>For your account, we are the controller.</strong> We decide how your account
            details are used, as this notice describes.
          </li>
          <li>
            <strong>For the emails you send, we are your processor.</strong> The people you email
            are your recipients, not ours: we handle their data only to send your emails and report
            on them, on your instructions, under the{' '}
            <Link href="/legal/dpa">Data Processing Agreement</Link>.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="controller" title="Who is responsible">
        <p>
          {BUSINESS.operator} ({BUSINESS.rcNumber}), trading as {BUSINESS.brand}. For anything about
          personal data, email <EmailLink />.
        </p>
      </LegalSection>

      <LegalSection id="account-data" title="What we hold about account holders">
        <ul>
          <li>
            <strong>Your sign-in:</strong> email address and name. Your password is handled by our
            sign-in provider and never stored in readable form.
          </li>
          <li>
            <strong>Your business:</strong> its name, website, what you will send and roughly how
            much — what we review an account by.
          </li>
          <li>
            <strong>Your team:</strong> the people you add or invite, their email addresses and
            roles. An invitation is emailed to the address you give.
          </li>
          <li>
            <strong>API keys:</strong> a hash of each key and its first characters, never the key
            itself.
          </li>
          <li>
            <strong>Your account’s security log:</strong> keys created or revoked, members added,
            domains removed — and who did it.
          </li>
          <li>
            <strong>Payments, once paid plans open:</strong> your plan, and each payment’s amount
            and Flutterwave reference. We never receive card details.
          </li>
          <li>
            <strong>Technical data:</strong> our hosting providers keep standard request logs,
            including IP addresses, for a short time.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="recipient-data" title="What we hold about your recipients">
        <ul>
          <li>
            <strong>Addresses:</strong> each email’s from, to, cc, bcc and reply-to addresses.
          </li>
          <li>
            <strong>The email log:</strong> subject, tags, status, times, and the delivery events
            Amazon reports, with every address struck out of their detail.
          </li>
          <li>
            <strong>The message itself:</strong> body and attachments, held only until it is sent
            and for 72 hours after.
          </li>
          <li>
            <strong>Your suppression list:</strong> addresses that bounced or complained, why and
            when, so they are not sent to again.
          </li>
        </ul>
        <p>
          We never write a recipient’s address, a subject or a message body into our logs, and we
          keep a message body nowhere but the record that is deleted after 72 hours.
        </p>
      </LegalSection>

      <LegalSection id="why" title="Why we use it">
        <ul>
          <li>
            <strong>To run your account and send your email</strong> — necessary to perform our
            contract with you.
          </li>
          <li>
            <strong>To email you about your account</strong> — invitations, sending limits reached,
            payments not received, webhooks turned off and sending paused — necessary to perform our
            contract with you, so these emails cannot be switched off. An invitation goes to the
            person invited; payment emails to the account’s owner; the rest to its owner and admins.
            They come from no-reply@notify.mydomainshub.com, through the same Amazon SES account.
          </li>
          <li>
            <strong>To review accounts, and to stop spam, phishing and abuse</strong> — our
            legitimate interest in protecting recipients, other customers and the service.
          </li>
          <li>
            <strong>To take payments and keep tax records</strong> — contract and legal obligation.
          </li>
        </ul>
        <p>We do not sell personal data or use it for advertising.</p>
      </LegalSection>

      <LegalSection id="keep" title="How long we keep it">
        <ul>
          <li>
            <strong>Message bodies and attachments:</strong> 72 hours after the email leaves the
            queue, then deleted.
          </li>
          <li>
            <strong>The email log and its events:</strong> for the log retention of the account’s
            plan, shown on the <Link href="/pricing">pricing page</Link>.
          </li>
          <li>
            <strong>The suppression list:</strong> while the account is open.
          </li>
          <li>
            <strong>Account details:</strong> while the account is open. Payment records: as long as
            tax law requires.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="share" title="Who receives it">
        <p>
          The companies whose services we use to run Mail — Amazon Web Services for sending,
          Supabase for our database, and others — are listed, with what each receives and where, on
          the <Link href="/legal/sub-processors">sub-processors</Link> page. We share personal data
          with authorities only where the law or a court order requires it.
        </p>
      </LegalSection>

      <LegalSection id="abroad" title="Transfers outside Nigeria">
        <p>
          Email is sent through Amazon’s London region and our database is in London, United
          Kingdom; our website and API are hosted by a company in the United States. We rely on our
          providers’ data protection terms for these transfers.
        </p>
      </LegalSection>

      <LegalSection id="cookies" title="Cookies">
        <p>
          Only the cookies that keep you signed in (their names start <code>sb-</code>) — none for
          analytics or advertising. Your light or dark theme is kept in your browser’s own storage,
          not a cookie.
        </p>
      </LegalSection>

      <LegalSection id="rights" title="Your rights">
        <p>Under the Nigeria Data Protection Act 2023 you can ask us to:</p>
        <ul>
          <li>give you a copy of your personal data;</li>
          <li>correct it if it is wrong;</li>
          <li>delete it, except what we must keep, such as tax records;</li>
          <li>restrict or object to how we use it;</li>
          <li>give it to you in a form you can take elsewhere.</li>
        </ul>
        <p>
          <strong>If you received an email sent through us</strong>, the sender holds your data and
          answers for it: ask them first. If you cannot reach them, email us and we will pass your
          request on and help them answer it.
        </p>
        <p>
          Email <EmailLink /> to make a request; we may ask you to confirm who you are. You can also
          complain to the{' '}
          <a href={NDPC} target="_blank" rel="noopener noreferrer">
            Nigeria Data Protection Commission
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection id="changes" title="Changes to this notice">
        <p>
          We update this notice when what we do with personal data changes; the date at the top
          shows the current version.
        </p>
      </LegalSection>
    </LegalPage>
  )
}
