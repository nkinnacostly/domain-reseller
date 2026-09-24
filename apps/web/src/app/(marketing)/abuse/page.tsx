import type { Metadata } from 'next'
import Link from 'next/link'
import { EmailLink, LegalPage, LegalSection } from '@/features/legal/components/legal-page'
import { pageMetadata } from '@/features/seo/lib/metadata'
import { BUSINESS, SPONSORING_REGISTRAR } from '@/lib/business'

export const metadata: Metadata = pageMetadata({
  title: 'Report abuse',
  description: `How to report a domain registered through ${BUSINESS.brand} that is used for phishing, malware, spam or other abuse.`,
  path: '/abuse',
})

/**
 * Abuse contact (PRD CMP-4). Registrars must publish one and act on reports;
 * the registrar's own abuse contact (read from the .com RDAP record) is given
 * too, per the PRD's "route to supplier abuse where appropriate".
 */
export default function AbusePage() {
  return (
    <LegalPage
      path="/abuse"
      title="Report abuse"
      nav="none"
      icons={['🚩', '🛡️', '✉️']}
      intro={
        <p>
          If a domain registered through {BUSINESS.brand} is being used for phishing, malware, spam,
          fraud or other illegal activity, tell us at <EmailLink />.
        </p>
      }
    >
      <LegalSection id="what" title="What to include">
        <ul>
          <li>The domain name.</li>
          <li>What is happening — for example, the page that imitates a bank.</li>
          <li>
            Evidence: the full web addresses, email headers for spam or phishing, and screenshots.
          </li>
          <li>How we can reach you, if you want to hear back.</li>
        </ul>
      </LegalSection>

      <LegalSection id="next" title="What happens next">
        <p>
          We review every report. Depending on what we find, we may contact the domain’s owner,
          suspend the domain under the{' '}
          <Link href="/legal/registration-agreement#suspension">registration agreement</Link>, or
          pass the report to the registrar, the registry or the website’s host.
        </p>
        <p>
          We register domains; we do not host websites or email. Content on a domain is usually
          removed fastest by the company hosting it, so report it to them as well.
        </p>
      </LegalSection>

      <LegalSection id="registrar" title="Contacting the registrar directly">
        <p>
          For .com domains registered through us, the sponsoring registrar is{' '}
          {SPONSORING_REGISTRAR.name}. Its abuse contact is{' '}
          <a href={`mailto:${SPONSORING_REGISTRAR.abuseEmail}`}>
            {SPONSORING_REGISTRAR.abuseEmail}
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection id="other" title="Not abuse?">
        <p>
          For a trademark dispute, see <Link href="/legal/udrp">domain name disputes</Link>. For
          anything else, <Link href="/contact">contact us</Link>.
        </p>
      </LegalSection>
    </LegalPage>
  )
}
