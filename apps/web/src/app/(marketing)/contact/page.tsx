import type { Metadata } from 'next'
import Link from 'next/link'
import { EmailLink, LegalPage, LegalSection } from '@/features/legal/components/legal-page'
import { BUSINESS } from '@/lib/business'

export const metadata: Metadata = {
  title: 'Contact us',
  description: `How to reach ${BUSINESS.brand}.`,
}

export default function ContactPage() {
  return (
    <LegalPage
      title="Contact us"
      nav="none"
      icons={['✉️', '💬', '🤝']}
      intro={
        <p>
          Email is the way to reach us: <EmailLink />. The <Link href="/help">help centre</Link> may
          already have your answer.
        </p>
      }
    >
      <LegalSection id="include" title="To help us help you">
        <ul>
          <li>Send it from the email address on your account, if you have one.</li>
          <li>Include the domain name, and your order number if it is about a purchase.</li>
          <li>Never send your password or a two-factor code — we will never ask for them.</li>
        </ul>
      </LegalSection>

      <LegalSection id="other" title="Something else">
        <ul>
          <li>
            A domain used for phishing, malware or other abuse:{' '}
            <Link href="/abuse">report abuse</Link>.
          </li>
          <li>
            A request about your personal data: email <EmailLink />; see the{' '}
            <Link href="/legal/privacy">privacy notice</Link>.
          </li>
          <li>
            A trademark dispute over a domain: see{' '}
            <Link href="/legal/udrp">domain name disputes</Link>.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="who" title="Who we are">
        <p>
          {BUSINESS.brand} is operated by {BUSINESS.operator}. See the{' '}
          <Link href="/legal">legal documents</Link>.
        </p>
      </LegalSection>
    </LegalPage>
  )
}
