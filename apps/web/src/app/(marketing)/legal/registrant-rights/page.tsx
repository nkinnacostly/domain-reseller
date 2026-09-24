import type { Metadata } from 'next'
import Link from 'next/link'
import { LegalPage, LegalSection, PolicyLink } from '@/features/legal/components/legal-page'
import { pageMetadata } from '@/features/seo/lib/metadata'
import { BUSINESS, POLICY_LINKS, SPONSORING_REGISTRAR } from '@/lib/business'

export const metadata: Metadata = pageMetadata({
  title: 'Registrants’ benefits and responsibilities',
  description:
    'Your rights and responsibilities as a domain name registrant, under ICANN’s specification.',
  path: '/legal/registrant-rights',
})

/**
 * CMP-2: publish, or link to, ICANN's Registrants' Benefits and
 * Responsibilities Specification. The official text is linked; the summary
 * here is in our own words and says where on this site each right is met.
 */
export default function RegistrantRightsPage() {
  return (
    <LegalPage
      path="/legal/registrant-rights"
      title="Registrants’ benefits and responsibilities"
      intro={
        <p>
          ICANN sets out what every domain name registrant is entitled to, and what they are
          responsible for. The official text is{' '}
          <PolicyLink href={POLICY_LINKS.registrantBenefits}>on ICANN’s website</PolicyLink>. Here
          it is in plain terms, with where to find each thing on {BUSINESS.brand}.
        </p>
      }
    >
      <LegalSection id="benefits" title="Your rights">
        <ul>
          <li>
            <strong>A registration agreement you can read at any time.</strong> Ours is the{' '}
            <Link href="/legal/registration-agreement">registration agreement</Link>; save a copy
            whenever you like.
          </li>
          <li>
            <strong>To know who your registrar is.</strong> For .com domains registered through us,
            it is {SPONSORING_REGISTRAR.name}. Every domain’s registrar is named in its public
            registration record.
          </li>
          <li>
            <strong>Clear prices and terms.</strong> Every price on this site is in naira, includes
            VAT, and is shown with its renewal price. Contact privacy is free where the extension
            allows it.
          </li>
          <li>
            <strong>To know how to get help and raise a complaint.</strong> See the{' '}
            <Link href="/help">help centre</Link> and <Link href="/contact">contact us</Link>.
          </li>
          <li>
            <strong>
              Instructions for registering, managing, transferring, renewing and restoring
            </strong>{' '}
            your domain — in the help centre and the registration agreement.
          </li>
          <li>
            <strong>No false advertising or deceptive practices</strong>, including hidden fees or
            misleading notices.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="responsibilities" title="Your responsibilities">
        <ul>
          <li>
            Follow the registration agreement and the registrar’s, registry’s and ICANN’s policies.
          </li>
          <li>Read the registration agreement, and any updates to it.</li>
          <li>You alone are responsible for registering and using your domain name.</li>
          <li>
            Give accurate contact details for the registration record, and update them promptly when
            they change.
          </li>
          <li>
            Answer enquiries from your registrar within 15 days, and keep your account details
            current.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="more" title="More from ICANN">
        <p>
          ICANN’s{' '}
          <PolicyLink href={POLICY_LINKS.registrantEducation}>
            registrant educational information
          </PolicyLink>{' '}
          explains how registrations, renewals, transfers and disputes work.
        </p>
      </LegalSection>
    </LegalPage>
  )
}
