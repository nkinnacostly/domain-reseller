import { TRANSFER_LOCK_DAYS } from '@dr/shared'
import type { Metadata } from 'next'
import {
  EmailLink,
  LegalPage,
  LegalSection,
  PolicyLink,
} from '@/features/legal/components/legal-page'
import { POLICY_LINKS } from '@/lib/business'

export const metadata: Metadata = {
  title: 'Transfer disputes',
  description:
    'Your right to move a domain to another registrar, and how transfer disputes are resolved under ICANN policy.',
}

/**
 * CMP-5 and PRD §7.3: link the Transfer Dispute Resolution Policy and state the
 * transfer rules we follow — including N14, never withholding a transfer code
 * over a billing dispute.
 */
export default function TransferDisputesPage() {
  return (
    <LegalPage
      title="Transfer disputes"
      intro={
        <p>
          You can move your domain to another registrar. ICANN’s Transfer Policy sets the rules for
          how that happens, and its Transfer Dispute Resolution Policy settles disagreements between
          registrars.
        </p>
      }
    >
      <LegalSection id="rights" title="Moving your domain away">
        <ul>
          <li>
            Email <EmailLink /> for the domain’s transfer code. We send it within five days, and we
            remove the transfer lock so the move can go ahead.
          </li>
          <li>We never refuse or delay a transfer because of a billing dispute.</li>
          <li>
            A transfer can be refused only for the reasons the policy allows — for example evidence
            of fraud, a dispute over who the registrant is, an open UDRP case or court order, or a
            domain registered, transferred or changed owner in the last {TRANSFER_LOCK_DAYS} days.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="disputes" title="If a transfer goes wrong">
        <p>
          If you believe a domain was transferred without authorisation, or a transfer was wrongly
          refused, email <EmailLink /> with the domain name and what happened. We will work with the
          registrars involved. Registrars that cannot agree can take the case to the registry under
          the Transfer Dispute Resolution Policy.
        </p>
      </LegalSection>

      <LegalSection id="official" title="The official texts">
        <ul>
          <li>
            <PolicyLink href={POLICY_LINKS.transferPolicy}>ICANN Transfer Policy</PolicyLink>
          </li>
          <li>
            <PolicyLink href={POLICY_LINKS.tdrp}>Transfer Dispute Resolution Policy</PolicyLink>
          </li>
        </ul>
      </LegalSection>
    </LegalPage>
  )
}
