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
  title: 'Privacy notice',
  description: `What personal data ${BUSINESS.brand} collects, why, who receives it, and your rights under the Nigeria Data Protection Act 2023.`,
}

/**
 * Privacy notice (PRD CMP-14, §7.7; NDPA 2023). Every statement matches the
 * code as of the date shown: the cookies are the Supabase session and the two
 * cart cookies (features/cart/lib/token*.ts), searches are not stored by us
 * (FR-S7), and no analytics or advertising scripts are loaded.
 */
export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy notice"
      intro={
        <p>
          How {BUSINESS.brand} handles your personal data, and your rights under the Nigeria Data
          Protection Act 2023. Registering a domain means sharing some details with registries
          around the world — this notice explains exactly what, and why.
        </p>
      }
    >
      <LegalSection id="controller" title="Who is responsible">
        <p>
          {BUSINESS.operator}, trading as {BUSINESS.brand}, is the data controller. For anything
          about your data, email <EmailLink />.
        </p>
      </LegalSection>

      <LegalSection id="collect" title="What we collect">
        <ul>
          <li>
            <strong>Your account:</strong> email address, name and, if you add them, phone number
            and business details. Your password is handled by our sign-in provider and never stored
            in readable form. If you turn on two-factor authentication, its secret is stored the
            same way.
          </li>
          <li>
            <strong>Registrant contact details:</strong> name, company, email, phone and postal
            address for each domain’s owner. We save them so you do not have to type them again.
          </li>
          <li>
            <strong>Your domains and orders:</strong> the domains you buy, their settings (such as
            nameservers), and your orders and payments — amount, method and Flutterwave’s reference.{' '}
            <strong>We never receive your card details</strong>; Flutterwave handles them.
          </li>
          <li>
            <strong>Your cart:</strong> the domains in it, found through a random code in a cookie
            if you are not signed in.
          </li>
          <li>
            <strong>Where you are signed in:</strong> for each device signed in to your account, the
            browser it reports, its IP address, and when it signed in and last renewed its sign-in.
            Our sign-in provider keeps these until that session ends; you can see them, and sign a
            device out, in Settings.
          </li>
          <li>
            <strong>Technical data:</strong> our hosting providers keep standard request logs, which
            include IP addresses and the addresses of pages you visit, for a short time. To stop one
            connection from overloading bulk search, we count the names it checks there, and the
            names it adds to a cart in one go, against a one-way hash of the IP address — never the
            address itself.
          </li>
        </ul>
        <p>
          We do not keep a record of the domains you search for, and we do not use analytics or
          advertising trackers. A CSV file you upload to bulk search is read on your device: only
          the names in it are sent to us, to be checked, and the file itself never is.
        </p>
      </LegalSection>

      <LegalSection id="why" title="Why we use it, and on what legal basis">
        <ul>
          <li>
            <strong>To run your account and register your domains</strong> — necessary to perform
            our contract with you.
          </li>
          <li>
            <strong>To send registrant details to the registrar and registry</strong>, which the
            registration itself requires — necessary to perform the contract, and required by the
            registry’s and ICANN’s rules.
          </li>
          <li>
            <strong>To take payments and keep tax and accounting records</strong> — contract and
            legal obligation.
          </li>
          <li>
            <strong>To keep the service secure and handle abuse and fraud</strong> — our legitimate
            interest in protecting you, us and others.
          </li>
        </ul>
        <p>We do not sell your data or use it for advertising.</p>
      </LegalSection>

      <LegalSection id="share" title="Who receives it">
        <ul>
          <li>
            <strong>Our registration supplier DomainNameAPI</strong> and its ICANN-accredited
            registrar, {SPONSORING_REGISTRAR.name} ({SPONSORING_REGISTRAR.country}) — registrant
            details, to register and manage your domain.
          </li>
          <li>
            <strong>The registry for your extension</strong> — for example Verisign (United States)
            for .com. Registries receive registrant details and may publish some of them.
          </li>
          <li>
            <strong>Flutterwave</strong> — to process your payment. Its payment notifications reach
            us through a webhook service we operate for our businesses.
          </li>
          <li>
            <strong>Supabase</strong> — our database and sign-in provider; your data is stored in
            London, United Kingdom.
          </li>
          <li>
            <strong>Fly.io</strong> — runs our registration service, in London, United Kingdom.
          </li>
          <li>
            <strong>Vercel</strong> — hosts this website (United States, with servers worldwide).
          </li>
          <li>
            <strong>Authorities and dispute providers</strong>, where the law, a court order or a
            domain dispute requires it.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="abroad" title="Transfers outside Nigeria">
        <p>
          Registering a domain is international by nature, so your data goes to Türkiye, the United
          Kingdom, the United States and the country of your extension’s registry. We transfer it
          because it is necessary to provide the registration you asked for, and rely on our
          providers’ data protection terms where they offer them.
        </p>
      </LegalSection>

      <LegalSection id="public" title="The public registration record">
        <p>
          Registries publish registration data in a public record (RDAP, formerly WHOIS), under
          ICANN’s{' '}
          <PolicyLink href={POLICY_LINKS.registrationDataPolicy}>
            Registration Data Policy
          </PolicyLink>
          . Where the extension allows it, contact privacy keeps your personal details out of that
          record, at no charge.
        </p>
      </LegalSection>

      <LegalSection id="keep" title="How long we keep it">
        <ul>
          <li>Account details: while your account is open.</li>
          <li>
            Registrant details: for as long as the domain is registered, and afterwards for as long
            as registry and ICANN rules require.
          </li>
          <li>Orders and payments: for as long as tax and accounting law requires.</li>
          <li>The cart cookie: 60 days.</li>
        </ul>
      </LegalSection>

      <LegalSection id="cookies" title="Cookies">
        <p>We only use cookies the site needs to work — none for analytics or advertising.</p>
        <ul>
          <li>
            <strong>Sign-in cookies</strong> (starting <code>sb-</code>): keep you signed in until
            you sign out.
          </li>
          <li>
            <strong>
              <code>dr_cart</code>
            </strong>
            : finds your cart when you are not signed in. Lasts 60 days.
          </li>
          <li>
            <strong>
              <code>dr_cart_count</code>
            </strong>
            : the number shown on the cart icon. Lasts 60 days.
          </li>
        </ul>
        <p>Your light or dark theme choice is kept in your browser’s own storage, not a cookie.</p>
      </LegalSection>

      <LegalSection id="security" title="How we protect it">
        <p>
          Everything travels over encrypted connections. Access to our systems is restricted, and
          you can protect your account with two-factor authentication — changing nameservers and
          other sensitive settings requires it.
        </p>
      </LegalSection>

      <LegalSection id="rights" title="Your rights">
        <p>Under the Nigeria Data Protection Act 2023 you can ask us to:</p>
        <ul>
          <li>give you a copy of your personal data;</li>
          <li>correct it if it is wrong;</li>
          <li>
            delete it — except what we must keep, such as the details of a domain that is still
            registered, or tax records;
          </li>
          <li>restrict or object to how we use it;</li>
          <li>give it to you in a form you can take elsewhere.</li>
        </ul>
        <p>
          Email <EmailLink /> to make a request; we may ask you to confirm who you are. If you are
          unhappy with how we handle your data, you can complain to the{' '}
          <PolicyLink href={POLICY_LINKS.ndpc}>Nigeria Data Protection Commission</PolicyLink>.
        </p>
      </LegalSection>

      <LegalSection id="age" title="Age">
        <p>{BUSINESS.brand} is for people aged 18 and over.</p>
      </LegalSection>

      <LegalSection id="changes" title="Changes to this notice">
        <p>
          We will update this notice when what we do with your data changes; the date at the top
          shows the current version. See also the{' '}
          <Link href="/legal/registration-agreement">registration agreement</Link>.
        </p>
      </LegalSection>
    </LegalPage>
  )
}
