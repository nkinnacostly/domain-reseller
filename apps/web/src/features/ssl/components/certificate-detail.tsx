import { type Contact, SSL_TERM } from '@dr/shared'
import { certificateFailureReason } from '@dr/shared/email'
import { Mail } from 'lucide-react'
import Link from 'next/link'
import { FormMessage } from '@/components/common/form-parts'
import { PANEL_HEADING, Panel } from '@/components/layout/panel'
import { RefreshWhile } from '@/features/checkout/components/refresh-while'
import type { RegistrantForm } from '@/features/checkout/lib/contact'
import { BUSINESS } from '@/lib/business'
import { certificateFiles } from '../lib/files'
import {
  approvalDomain,
  certificateState,
  daysLeft,
  REISSUE_SOON_DAYS,
  setupProblem,
} from '../lib/status'
import type { CertificateRow } from '../queries/certificates'
import { CertificateSetupForm } from './certificate-setup-form'
import { IssuedCertificate } from './issued-certificate'

const DATE = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'Africa/Lagos' })
const when = (iso: string | null) => (iso ? DATE.format(new Date(iso)) : null)

/** A stored contact back into the form's shape, to fix a refused set-up without retyping it. */
export function contactToForm(contact: unknown): RegistrantForm | null {
  if (!contact || typeof contact !== 'object') return null
  const c = contact as Partial<Contact>
  if (!c.firstName || !c.email) return null
  return {
    firstName: c.firstName,
    lastName: c.lastName ?? '',
    company: c.company ?? '',
    email: c.email,
    phoneCountryCode: c.phoneCountryCode ?? '234',
    phone: c.phone ?? '',
    addressLine1: c.addressLine1 ?? '',
    addressLine2: c.addressLine2 ?? '',
    city: c.city ?? '',
    state: c.state ?? '',
    zipCode: c.zipCode ?? '',
    country: c.country ?? 'NG',
  }
}

function Waiting({ title, body }: { title: string; body: string }) {
  return (
    <div className="space-y-2" role="status">
      <p className="font-medium text-foreground">{title}</p>
      <p className="max-w-2xl text-pretty text-sm/6 text-muted-foreground">{body}</p>
      <div aria-hidden="true" className="mt-4 h-2 w-40 animate-pulse rounded-full bg-muted" />
    </div>
  )
}

/** The main card: what to do now, by where the certificate stands (FR-SSL-4 – FR-SSL-8). */
function Step({
  certificate,
  contact,
  now,
}: {
  certificate: CertificateRow
  contact: RegistrantForm
  now: Date
}) {
  switch (certificate.status) {
    case 'pending':
      return (
        <Waiting
          title="Ordering your certificate."
          body="We are buying it from the certificate authority’s supplier. This page updates by itself — usually within a minute."
        />
      )
    case 'awaiting_setup':
      return (
        <CertificateSetupForm
          certificateId={certificate.id}
          commonName={certificate.common_name}
          isWildcard={certificate.is_wildcard}
          includedNames={certificate.included_names}
          contact={contactToForm(certificate.contact) ?? contact}
          problem={setupProblem(certificate.last_error_code)}
        />
      )
    case 'setting_up':
      return (
        <Waiting
          title="Sending your set-up."
          body="We are passing your request to the certificate authority. Next, it emails your approver."
        />
      )
    case 'reissuing':
      return (
        <Waiting
          title="Asking for a new certificate."
          body="The certificate authority makes a new one for the same names. This page updates by itself."
        />
      )
    case 'awaiting_validation':
      return (
        <div className="space-y-4">
          <p className="font-medium text-foreground">
            Approve the email from the certificate authority.
          </p>
          <ol className="max-w-2xl list-decimal space-y-2 pl-5 text-pretty text-sm/6 text-muted-foreground">
            <li>
              Sectigo, the certificate authority, emails{' '}
              <span className="font-mono break-all text-foreground">
                {certificate.approver_email}
              </span>{' '}
              to confirm you control {approvalDomain(certificate.common_name)}.
            </li>
            <li>Open that email and follow its link to approve the certificate.</li>
            <li>
              We ask the supplier every few minutes. Once it is issued, it appears here to download.
            </li>
          </ol>
          <FormMessage tone="success">
            <Mail className="sr-only" aria-hidden="true" />
            Not there? Check spam, and that the mailbox exists — most email hosts let you create an
            admin@ or webmaster@ address. If nothing arrives within a day, email{' '}
            <a href={`mailto:${BUSINESS.email}`} className="underline underline-offset-2">
              {BUSINESS.email}
            </a>{' '}
            with the certificate’s name.
          </FormMessage>
        </div>
      )
    case 'issued': {
      const days = daysLeft(certificate.expires_at, now)
      return (
        <div className="space-y-4">
          <p className="max-w-2xl text-pretty text-sm/6 text-muted-foreground">
            Install it on your server or hosting together with the private key you made the request
            with — your host’s SSL settings ask for both, and usually the chain too. Visitors see it
            only once it is installed.
          </p>
          {days !== null && days <= REISSUE_SOON_DAYS ? (
            <FormMessage tone="error">
              {days === 0
                ? 'This certificate has expired.'
                : `This certificate expires in ${days} ${days === 1 ? 'day' : 'days'}.`}{' '}
              Reissue it below while your subscription lasts.
            </FormMessage>
          ) : null}
          <IssuedCertificate
            certificateId={certificate.id}
            files={certificateFiles(
              certificate.common_name,
              certificate.certificate_pem,
              certificate.ca_bundle_pem,
            )}
            canReissue
          />
        </div>
      )
    }
    case 'failed':
      return (
        <FormMessage tone="error">
          {certificateFailureReason(certificate.last_error_code)}{' '}
          {certificate.test_mode
            ? 'This was a test payment, so no money moved.'
            : 'What you paid for it is refunded automatically — see the order.'}
        </FormMessage>
      )
    default:
      return (
        <FormMessage tone="error">
          The certificate authority shows this certificate as {certificate.status}. Email{' '}
          {BUSINESS.email} with its name and we will look into it.
        </FormMessage>
      )
  }
}

/** A certificate's page, below its header. */
export function CertificateDetail({
  certificate,
  contact,
  now = new Date(),
}: {
  certificate: CertificateRow
  contact: RegistrantForm
  now?: Date
}) {
  const state = certificateState(certificate.status, certificate.expires_at, now)
  const names = [certificate.common_name, ...certificate.san_names]
  return (
    <>
      <RefreshWhile
        active={state.settling}
        everyMs={certificate.status === 'awaiting_validation' ? 30_000 : 4_000}
      />
      {certificate.test_mode ? (
        <FormMessage tone="success">
          <span className="font-medium">Test certificate.</span> Ordered from a test payment in the
          supplier’s test system. Browsers do not trust it.
        </FormMessage>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <Panel labelledBy="step-heading">
          <h2 id="step-heading" className="sr-only">
            What happens now
          </h2>
          <Step certificate={certificate} contact={contact} now={now} />
        </Panel>

        <Panel labelledBy="about-heading" className="h-fit text-sm/6">
          <h2 id="about-heading" className={PANEL_HEADING}>
            About this certificate
          </h2>
          <dl className="mt-3 space-y-3">
            <div>
              <dt className="text-muted-foreground">Product</dt>
              <dd className="text-foreground">{certificate.product_name}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{names.length > 1 ? 'Names' : 'Name'}</dt>
              <dd className="font-mono text-xs break-all text-foreground">{names.join(', ')}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Subscription</dt>
              <dd className="text-foreground">
                {certificate.subscription_ends_at
                  ? `${when(certificate.purchased_at)} to ${when(certificate.subscription_ends_at)}`
                  : certificate.purchased_at
                    ? `${SSL_TERM.short}, bought ${when(certificate.purchased_at)}`
                    : SSL_TERM.short}
              </dd>
            </div>
            {certificate.issued_at || certificate.expires_at ? (
              <div>
                <dt className="text-muted-foreground">This certificate</dt>
                <dd className="text-foreground">
                  {certificate.issued_at ? `Issued ${when(certificate.issued_at)}` : 'Issued'}
                  {certificate.expires_at ? ` · expires ${when(certificate.expires_at)}` : ''}
                </dd>
              </div>
            ) : null}
          </dl>
          <p className="mt-4 text-pretty text-muted-foreground">{SSL_TERM.long}</p>
          <p className="mt-2 text-pretty text-muted-foreground">
            It never renews by itself. When the subscription ends, buy a new certificate from the{' '}
            <Link href="/ssl" className="underline underline-offset-2 hover:text-foreground">
              SSL page
            </Link>
            . Revoking a certificate is done on request: email {BUSINESS.email}.
          </p>
        </Panel>
      </div>
    </>
  )
}
