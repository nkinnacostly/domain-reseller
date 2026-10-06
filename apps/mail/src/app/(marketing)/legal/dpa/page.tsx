import { Handshake, LockKey, Scroll } from '@phosphor-icons/react/ssr'
import type { Metadata } from 'next'
import Link from 'next/link'
import { EmailLink, LegalPage, LegalSection } from '@/features/legal/components/legal-page'
import { pageMetadata } from '@/features/seo/lib/metadata'
import { BUSINESS } from '@/lib/business'

export const metadata: Metadata = pageMetadata({
  title: 'Data Processing Agreement',
  description:
    'How MyDomainsHub Mail processes your recipients’ personal data on your behalf, under the Nigeria Data Protection Act 2023.',
  path: '/legal/dpa',
})

/**
 * Data Processing Agreement (MAIL-SPEC §10, §14.5): we process recipients'
 * data for the customer (MR4). Security measures named here are ones the
 * code has (MR3, MR7, §4.3, N13). A draft until the lawyer has reviewed it.
 */
export default function DpaPage() {
  return (
    <LegalPage
      path="/legal/dpa"
      title="Data Processing Agreement"
      icons={[Handshake, Scroll, LockKey]}
      intro={
        <p>
          When you send email through {BUSINESS.product}, we process your recipients’ personal data
          for you. This agreement sets out how, under the Nigeria Data Protection Act 2023. It forms
          part of our <Link href="/legal/terms">Terms of Service</Link>.
        </p>
      }
    >
      <LegalSection id="parties" title="The parties and their roles">
        <p>
          You, the account holder, are the data controller for the personal data in the emails you
          send. {BUSINESS.operator} ({BUSINESS.rcNumber}), trading as {BUSINESS.brand}, is your data
          processor.
        </p>
      </LegalSection>

      <LegalSection id="scope" title="What we process, and why">
        <ul>
          <li>
            <strong>Purpose:</strong> sending the emails you ask us to send, reporting what happened
            to them, and keeping your suppression list.
          </li>
          <li>
            <strong>People:</strong> your recipients, and anyone named in an email’s addresses.
          </li>
          <li>
            <strong>Data:</strong> email addresses and names in them; each email’s subject, tags,
            body and attachments, and whatever personal data you put in them; delivery events.
          </li>
          <li>
            <strong>Duration:</strong> for as long as your account is open, then as set out under
            “Deletion”.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="instructions" title="Your instructions">
        <p>
          We process this data only to provide the service — that is, on the instructions you give
          through the API and your account — or where the law requires us to, in which case we tell
          you unless the law forbids it. You are responsible for having a lawful basis, and your
          recipients’ consent where it is needed, for every email you send.
        </p>
      </LegalSection>

      <LegalSection id="security" title="Security">
        <ul>
          <li>Everything travels over encrypted connections.</li>
          <li>
            Each account’s data is kept apart by row-level security in our database: a member of one
            account cannot read another’s.
          </li>
          <li>API keys are stored only as hashes.</li>
          <li>
            Only the mail worker holds the credentials that can send email; our website and API
            cannot send.
          </li>
          <li>Recipient addresses, subjects and message bodies are never written to our logs.</li>
        </ul>
      </LegalSection>

      <LegalSection id="sub-processors" title="Sub-processors">
        <p>
          You authorise the sub-processors on our{' '}
          <Link href="/legal/sub-processors">sub-processors</Link> page. We bind each to data
          protection terms no weaker than these. Before we add or replace one that receives your
          recipients’ data, we will update that page and email account owners, and you may object by
          closing your account before the change takes effect.
        </p>
      </LegalSection>

      <LegalSection id="assistance" title="Helping you meet your obligations">
        <ul>
          <li>We pass on any request from a recipient about their data, and help you answer it.</li>
          <li>
            If we become aware of a breach affecting your recipients’ data, we tell you without
            undue delay, with what we know, so you can meet your own duty to notify.
          </li>
          <li>We give you the information you reasonably need to show you meet the Act.</li>
        </ul>
      </LegalSection>

      <LegalSection id="deletion" title="Deletion">
        <ul>
          <li>
            Message bodies and attachments are deleted 72 hours after an email leaves the queue.
          </li>
          <li>The email log is deleted at the end of your plan’s log retention.</li>
          <li>
            When your account closes, we delete what remains of your recipients’ data, except what
            the law requires us to keep.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="transfers" title="Transfers outside Nigeria">
        <p>
          Your recipients’ data is processed in the United Kingdom (Amazon SES’s London region and
          our database) and passes through servers in the United States (our hosting). We rely on
          our sub-processors’ data protection terms for these transfers.
        </p>
      </LegalSection>

      <LegalSection id="contact" title="Contact">
        <p>
          Email <EmailLink />.
        </p>
      </LegalSection>
    </LegalPage>
  )
}
