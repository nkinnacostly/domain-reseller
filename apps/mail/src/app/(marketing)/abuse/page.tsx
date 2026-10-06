import { EnvelopeSimple, Flag, ShieldWarning } from '@phosphor-icons/react/ssr'
import type { Metadata } from 'next'
import Link from 'next/link'
import { LegalPage, LegalSection } from '@/features/legal/components/legal-page'
import { ABUSE_FIELDS, abuseMailto } from '@/features/legal/lib/abuse-report'
import { pageMetadata } from '@/features/seo/lib/metadata'
import { BUSINESS } from '@/lib/business'

export const metadata: Metadata = pageMetadata({
  title: 'Report abuse',
  description:
    'How to report spam, phishing, malware or impersonation sent through MyDomainsHub Mail, and what to include.',
  path: '/abuse',
})

/**
 * Abuse reports (MAIL-SPEC §7.7). An email with the fields we need: no form
 * stores anything yet — the report form and its queue come with the admin
 * package.
 */
export default function AbusePage() {
  return (
    <LegalPage
      kind="support"
      path="/abuse"
      title="Report abuse"
      icons={[Flag, ShieldWarning, EnvelopeSimple]}
      intro={
        <p>
          If an email sent through {BUSINESS.product} is spam, phishing, malware or pretends to be
          someone it is not, tell us at <a href={`mailto:${BUSINESS.email}`}>{BUSINESS.email}</a>.
        </p>
      }
    >
      <LegalSection id="report" title="Send a report">
        <p>
          The link below opens an email to us with these fields ready to fill in. Attach the email
          itself if you can.
        </p>
        <ol>
          {ABUSE_FIELDS.map((field) => (
            <li key={field}>{field}</li>
          ))}
        </ol>
        <p className="mt-6!">
          <a
            href={abuseMailto()}
            className="inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-6 text-sm font-medium text-primary-foreground! no-underline! transition-colors hover:text-primary-foreground! hover:bg-primary/90 active:scale-[0.98]"
          >
            <EnvelopeSimple aria-hidden="true" weight="duotone" className="size-5" />
            Email an abuse report
          </a>
        </p>
      </LegalSection>

      <LegalSection id="headers" title="Why the headers matter">
        <p>
          The full headers show the email came through us and let us find it, and the account that
          sent it. Most mail apps show them under “Show original” or “View source”.
        </p>
      </LegalSection>

      <LegalSection id="next" title="What happens next">
        <p>
          We review every report. If an account has broken our{' '}
          <Link href="/legal/acceptable-use">Acceptable Use Policy</Link>, we pause its sending, and
          close it if the breach is serious or continues.
        </p>
        <p>
          If you no longer want emails from a sender, tell the sender too: they hold your address,
          not us.
        </p>
      </LegalSection>

      <LegalSection id="other" title="Not abuse?">
        <p>
          For anything else, <Link href="/contact">contact us</Link>.
        </p>
      </LegalSection>
    </LegalPage>
  )
}
