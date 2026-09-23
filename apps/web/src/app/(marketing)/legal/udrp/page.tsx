import type { Metadata } from 'next'
import Link from 'next/link'
import {
  EmailLink,
  LegalPage,
  LegalSection,
  PolicyLink,
} from '@/features/legal/components/legal-page'
import { POLICY_LINKS } from '@/lib/business'

export const metadata: Metadata = {
  title: 'Domain name disputes (UDRP)',
  description:
    'How disputes over who should hold a domain name are resolved under ICANN’s Uniform Domain-Name Dispute-Resolution Policy.',
}

/** CMP-5: link the UDRP. The policy and its rules are ICANN's; this explains them. */
export default function UdrpPage() {
  return (
    <LegalPage
      title="Domain name disputes (UDRP)"
      intro={
        <p>
          If someone believes a domain infringes their trademark, the dispute is usually settled
          under ICANN’s Uniform Domain-Name Dispute-Resolution Policy (UDRP) — a faster, cheaper
          alternative to court that every registrant of a generic domain agrees to.
        </p>
      }
    >
      <LegalSection id="how" title="How it works">
        <ol>
          <li>
            A trademark holder files a complaint with an approved dispute-resolution provider, such
            as the World Intellectual Property Organization (WIPO).
          </li>
          <li>
            To win, they must show that the domain is identical or confusingly similar to their
            trademark, that the registrant has no rights or legitimate interests in it, and that it
            was registered and is being used in bad faith.
          </li>
          <li>The registrant is notified and can respond.</li>
          <li>
            A panel decides. The domain can be cancelled or transferred to the complainant; if not,
            it stays where it is.
          </li>
        </ol>
        <p>
          While a case is open the domain is locked: it cannot be transferred to another registrar
          or registrant.
        </p>
      </LegalSection>

      <LegalSection id="official" title="The official texts">
        <ul>
          <li>
            <PolicyLink href={POLICY_LINKS.udrp}>
              Uniform Domain-Name Dispute-Resolution Policy
            </PolicyLink>
          </li>
          <li>
            <PolicyLink href={POLICY_LINKS.udrpRules}>Rules for the UDRP</PolicyLink>
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="us" title="Our role">
        <p>
          We do not decide disputes. We and the registrar carry out a panel’s decision, a court
          order, or what the parties agree. If you receive a complaint about a domain you hold with
          us, email <EmailLink /> straight away. For abuse such as phishing or malware, use{' '}
          <Link href="/abuse">report abuse</Link> instead.
        </p>
      </LegalSection>
    </LegalPage>
  )
}
