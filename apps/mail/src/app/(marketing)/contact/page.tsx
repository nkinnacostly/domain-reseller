import { ChatsCircle, EnvelopeSimple, Handshake } from '@phosphor-icons/react/ssr'
import type { Metadata } from 'next'
import Link from 'next/link'
import { EmailLink, LegalPage, LegalSection } from '@/features/legal/components/legal-page'
import { pageMetadata } from '@/features/seo/lib/metadata'
import { organizationLd } from '@/features/seo/lib/structured-data'
import { BUSINESS } from '@/lib/business'
import { env } from '@/lib/env'

export const metadata: Metadata = pageMetadata({
  title: 'Contact us',
  description: 'How to reach the people behind MyDomainsHub Mail, and what to include.',
  path: '/contact',
})

/** Contact (MAIL-SPEC §10): one address, as the shop's (lib/business.ts). */
export default function ContactPage() {
  return (
    <LegalPage
      kind="support"
      path="/contact"
      title="Contact us"
      icons={[EnvelopeSimple, ChatsCircle, Handshake]}
      structuredData={[organizationLd(env.NEXT_PUBLIC_MAIL_URL)]}
      intro={
        <p>
          Email is the way to reach us: <a href={`mailto:${BUSINESS.email}`}>{BUSINESS.email}</a>.
        </p>
      }
    >
      <LegalSection id="include" title="To help us help you">
        <ul>
          <li>Write from the email address you sign in with, if you have an account.</li>
          <li>
            About one email: include its id, the one the API returned. Leave out recipients’
            addresses unless we ask.
          </li>
          <li>
            Never send an API key, a password or a sign-in code. We will never ask for one; revoke
            any key you have shared.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="other" title="Something else">
        <ul>
          <li>
            Spam, phishing or malware sent through us: <Link href="/abuse">report abuse</Link>.
          </li>
          <li>
            A request about personal data: email <EmailLink />; see the{' '}
            <Link href="/legal/privacy">Privacy Notice</Link>.
          </li>
          <li>
            Plans and caps: see <Link href="/pricing">pricing</Link>.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="who" title="Who we are">
        <p>
          {BUSINESS.product} is run by {BUSINESS.operator} ({BUSINESS.rcNumber}), trading as{' '}
          {BUSINESS.brand} — the company behind the domain shop at{' '}
          <a href={BUSINESS.shopUrl}>{BUSINESS.shopSite}</a>. See the{' '}
          <Link href="/legal">legal documents</Link>.
        </p>
      </LegalSection>
    </LegalPage>
  )
}
