import { TRANSFER_LOCK_DAYS } from '@dr/shared'
import type { Metadata } from 'next'
import Link from 'next/link'
import {
  EmailLink,
  LegalPage,
  LegalSection,
  PolicyLink,
} from '@/features/legal/components/legal-page'
import { BUSINESS, POLICY_LINKS, SPONSORING_REGISTRAR } from '@/lib/business'

export const metadata: Metadata = {
  title: 'Registration agreement',
  description: `The terms for registering and managing a domain with ${BUSINESS.brand}, including who your registrar is.`,
}

/**
 * The registration agreement (PRD CMP-1, FR-PUB4). It must identify the
 * sponsoring registrar and carry the registrant provisions ICANN's 2013 RAA
 * (§3.7.7) requires in every registration agreement. Copy states only what
 * the service does today (N9b): renewal is online and paid by the customer;
 * contacts, the transfer lock and the transfer code are self-serve in the
 * account (FR-DS1, FR-DS4, FR-DS5); automatic renewal and restores are not
 * built, so the agreement says so and gives the way that works now.
 */
export default function RegistrationAgreementPage() {
  return (
    <LegalPage
      title="Registration agreement"
      intro={
        <p>
          These are the terms for registering, renewing and managing a domain name with{' '}
          {BUSINESS.brand}. By paying for a registration you agree to them, and to the policies they
          point to.
        </p>
      }
    >
      <LegalSection id="who" title="Who we are">
        <p>
          {BUSINESS.brand} ({BUSINESS.site}) is operated by {BUSINESS.operator} (“we”, “us”). We are
          an authorised <strong>reseller</strong>: we sell domain registrations provided by an
          ICANN-accredited registrar. We are not ourselves accredited by ICANN.
        </p>
      </LegalSection>

      <LegalSection id="registrar" title="Your registrar and registry">
        <p>
          Every domain is sponsored by an ICANN-accredited <strong>registrar</strong> and held by
          the <strong>registry</strong> that runs its extension. For <strong>.com</strong> domains
          registered through us, the registrar is <strong>{SPONSORING_REGISTRAR.name}</strong> (
          {SPONSORING_REGISTRAR.country}, IANA ID {SPONSORING_REGISTRAR.ianaId}), and the registry
          is Verisign.
        </p>
        <p>
          The registrar for any domain is named in its public registration record, which you can
          look up with <PolicyLink href={POLICY_LINKS.icannLookup}>ICANN Lookup</PolicyLink>. The
          registrar’s and the registry’s rules also apply to your domain, as do the ICANN consensus
          policies below.
        </p>
      </LegalSection>

      <LegalSection id="accurate" title="Keeping your details accurate">
        <p>
          You must give accurate and reliable contact details for the domain’s registrant (its legal
          owner) and for any administrative, technical or billing contact you name, and correct them
          within <strong>seven days</strong> of any change. Change them on the domain’s Contacts
          page in your account; the change is sent to the registry and shows there once the registry
          confirms it.
        </p>
        <p>
          Wilfully giving inaccurate or unreliable information, failing to update it promptly, or
          failing to respond within <strong>15 days</strong> to an enquiry about its accuracy is a
          material breach of this agreement and grounds for suspending or cancelling the
          registration. The registrar may email the registrant to verify their details; please
          answer it.
        </p>
      </LegalSection>

      <LegalSection id="data" title="How registration data is used">
        <p>
          We, the registrar and the registry use the registrant’s details to register and manage the
          domain, as described in our <Link href="/legal/privacy">privacy notice</Link>. Some
          details may appear in the public registration record (RDAP, formerly WHOIS). Where the
          extension allows it, contact privacy keeps personal details out of that record.
        </p>
        <p>
          If you give us contact details for someone else, you confirm that you have told them how
          their details will be used and that they agree.
        </p>
      </LegalSection>

      <LegalSection id="use" title="Your promises about the domain">
        <ul>
          <li>
            To the best of your knowledge, registering and using the domain does not infringe
            anyone’s legal rights, including trademarks.
          </li>
          <li>You will not use the domain for anything unlawful, or for abuse.</li>
          <li>
            If you let someone else use the domain, you remain the registrant and are responsible
            for harm caused by its wrongful use — unless you promptly name that person and give
            their current contact details to anyone who shows reasonable evidence of actionable
            harm.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="disputes" title="Disputes">
        <p>
          You agree to the{' '}
          <PolicyLink href={POLICY_LINKS.udrp}>
            Uniform Domain-Name Dispute-Resolution Policy
          </PolicyLink>{' '}
          (UDRP) for disputes with third parties over the registration or use of the domain. See{' '}
          <Link href="/legal/udrp">domain name disputes</Link>.
        </p>
        <p>
          For disputes arising from the use of the domain, you submit — without prejudice to other
          jurisdictions that may apply — to the jurisdiction of the courts where you live and where
          the registrar is located.
        </p>
        <p>
          To the extent the law allows, you agree to indemnify and hold harmless the registrar, the
          registry and us, and our directors, officers, employees and agents, against claims arising
          from your registration or use of the domain.
        </p>
      </LegalSection>

      <LegalSection id="suspension" title="Suspension and cancellation">
        <p>
          A registration may be suspended, cancelled or transferred to comply with the law, a court
          order, a UDRP decision, or the registry’s or registrar’s policies; to correct a mistake;
          or to stop abuse (see <Link href="/abuse">report abuse</Link>).
        </p>
      </LegalSection>

      <LegalSection id="prices" title="Prices and payment">
        <p>
          Prices are in naira. VAT at 7.5% is added at checkout as its own line. Every price is
          shown with its renewal price. You pay once, at checkout, through Flutterwave.
        </p>
        <p>
          Registration is complete only when the registry confirms it. If it cannot be completed
          after you have paid, you get a full refund — see the{' '}
          <Link href="/legal/refunds">refund policy</Link>. Once registered, a domain cannot be
          refunded.
        </p>
      </LegalSection>

      <LegalSection id="term" title="Term, renewal and expiry">
        <p>
          You choose the registration period at checkout, within the limits the extension allows.
          Your account shows each domain’s expiry date. Renewing on time is your responsibility.
        </p>
        <p>
          To renew, open the domain in your account, choose Renew, pick how many years to add and
          pay the total shown. The years are added to the current expiry date. We treat a renewal as
          done only once the registry shows the new expiry date; if the registry refuses it, what
          you paid is refunded. Automatic renewal is not switched on yet: the auto-renew setting
          records what you want, and nothing is charged without you paying for it. A domain in
          redemption cannot be renewed online — email <EmailLink /> for the cost of restoring it.
        </p>
        <p>
          If a domain expires, it usually stops working. Most generic extensions then allow a
          renewal grace period (often 30 to 45 days) when it can still be renewed at the normal
          price, followed by a redemption period (about 30 days) when it can be restored only by
          paying the registry’s restore fee as well. After that it is deleted and anyone may
          register it. The{' '}
          <PolicyLink href={POLICY_LINKS.errp}>Expired Registration Recovery Policy</PolicyLink>{' '}
          sets the rules.
        </p>
      </LegalSection>

      <LegalSection id="transfers" title="Transfers">
        <p>
          Transfer lock is on by default, which stops anyone moving the domain to another registrar.
          A domain cannot usually be transferred for {TRANSFER_LOCK_DAYS} days after it is
          registered, transferred or its registrant changes.
        </p>
        <p>
          After that you may move it to any registrar. The domain’s Security page in your account
          turns the transfer lock off and shows its transfer code straight away, after a two-factor
          check. If it cannot reach the registry, email <EmailLink /> and we will send the code
          within five days. We never withhold it over a billing dispute. The{' '}
          <PolicyLink href={POLICY_LINKS.transferPolicy}>ICANN Transfer Policy</PolicyLink> applies;
          see <Link href="/legal/transfer-disputes">transfer disputes</Link>.
        </p>
      </LegalSection>

      <LegalSection id="liability" title="Our liability">
        <p>
          We are not liable for losses caused by the registry or registrar, by outages outside our
          control, by DNS or hosting you run elsewhere, or by the loss of a domain you did not
          renew. To the extent the law allows, our total liability to you for a domain is limited to
          what you paid us for it in the previous twelve months.
        </p>
      </LegalSection>

      <LegalSection id="policies" title="Policies that form part of this agreement">
        <ul>
          <li>
            <Link href="/legal/registrant-rights">Registrants’ Benefits and Responsibilities</Link>
          </li>
          <li>
            <PolicyLink href={POLICY_LINKS.udrp}>
              Uniform Domain-Name Dispute-Resolution Policy
            </PolicyLink>
          </li>
          <li>
            <PolicyLink href={POLICY_LINKS.transferPolicy}>Transfer Policy</PolicyLink> and{' '}
            <PolicyLink href={POLICY_LINKS.tdrp}>Transfer Dispute Resolution Policy</PolicyLink>
          </li>
          <li>
            <PolicyLink href={POLICY_LINKS.errp}>Expired Registration Recovery Policy</PolicyLink>
          </li>
          <li>
            <PolicyLink href={POLICY_LINKS.registrationDataPolicy}>
              Registration Data Policy
            </PolicyLink>
          </li>
          <li>
            Our <Link href="/legal/privacy">privacy notice</Link> and{' '}
            <Link href="/legal/refunds">refund policy</Link>
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="changes" title="Changes and governing law">
        <p>
          We may update this agreement, for example when ICANN or a registry changes its rules. The
          date at the top shows the current version; changes apply to registrations and renewals
          made after that date. This agreement is governed by the laws of the Federal Republic of
          Nigeria, alongside the jurisdiction terms above that ICANN requires.
        </p>
      </LegalSection>

      <LegalSection id="contact" title="Contact">
        <p>
          {BUSINESS.operator}, trading as {BUSINESS.brand}: <EmailLink />.
        </p>
      </LegalSection>
    </LegalPage>
  )
}
