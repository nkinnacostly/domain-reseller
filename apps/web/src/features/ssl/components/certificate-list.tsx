import { ArrowRight, ShieldCheck } from 'lucide-react'
import Link from 'next/link'
import { FormMessage } from '@/components/common/form-parts'
import { FOCUS } from '@/components/layout/panel'
import { cn } from '@/lib/utils'
import { certificateState, daysLeft } from '../lib/status'
import type { CertificateSummary } from '../queries/certificates'
import { CertificateStatus } from './certificate-status'

const DATE = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'Africa/Lagos' })

/** What to say under a certificate's name: its next step, or its expiry. */
function nextLine(certificate: CertificateSummary, now: Date): string {
  switch (certificate.status) {
    case 'awaiting_setup':
      return 'Next: send the request and choose who approves it.'
    case 'awaiting_validation':
      return 'Next: approve the email from the certificate authority.'
    case 'issued': {
      const days = daysLeft(certificate.expires_at, now)
      if (days === null) return 'Issued.'
      return days === 0
        ? `Expired on ${DATE.format(new Date(certificate.expires_at as string))}.`
        : `Expires on ${DATE.format(new Date(certificate.expires_at as string))} — in ${days} ${days === 1 ? 'day' : 'days'}.`
    }
    case 'failed':
      return 'It could not be ordered; what you paid is refunded.'
    default:
      return 'This page updates as it moves.'
  }
}

/** FR-SSL-7: every certificate on the account, with where it stands. */
export function CertificateList({
  certificates,
  now = new Date(),
}: {
  certificates: CertificateSummary[] | null
  now?: Date
}) {
  if (certificates === null) {
    return (
      <FormMessage tone="error">
        We couldn’t load your certificates just now. Refresh the page to try again.
      </FormMessage>
    )
  }
  if (certificates.length === 0) {
    return (
      <div className="rounded-3xl border border-border border-dashed px-6 py-12 text-center">
        <span className="mx-auto grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
          <ShieldCheck className="size-5" aria-hidden="true" />
        </span>
        <h3 className="mt-4 text-lg font-semibold text-foreground">No SSL certificates yet</h3>
        <p className="mx-auto mt-2 max-w-sm text-pretty text-sm/6 text-muted-foreground">
          Many hosts give you a certificate for free. If yours does not, you can buy one here and
          install it yourself.
        </p>
        <Link
          href="/ssl"
          className={cn(
            'mt-6 inline-flex h-11 items-center gap-2 rounded-full bg-accent px-6 text-sm font-medium text-accent-foreground transition hover:bg-accent/90 active:scale-[0.98]',
            FOCUS,
          )}
        >
          See SSL certificates
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </div>
    )
  }

  return (
    <ul aria-label="Your SSL certificates" className="divide-y divide-border/70">
      {certificates.map((certificate) => (
        <li
          key={certificate.id}
          data-certificate={certificate.common_name}
          className="py-4 first:pt-0 last:pb-0"
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/app/ssl/${certificate.id}`}
                  className={cn(
                    'font-medium break-all text-foreground underline-offset-4 hover:underline',
                    FOCUS,
                  )}
                >
                  {certificate.common_name}
                </Link>
                <CertificateStatus
                  state={certificateState(certificate.status, certificate.expires_at, now)}
                />
                {certificate.test_mode ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">
                    Test
                  </span>
                ) : null}
              </p>
              <p className="mt-0.5 text-sm text-muted-foreground">{certificate.product_name}</p>
              <p className="text-sm text-muted-foreground">{nextLine(certificate, now)}</p>
            </div>
            <Link
              href={`/app/ssl/${certificate.id}`}
              aria-label={`Open the certificate for ${certificate.common_name}`}
              className={cn(
                'inline-flex h-11 shrink-0 items-center gap-2 self-start rounded-full border border-border bg-background px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted active:scale-[0.98] sm:self-auto',
                FOCUS,
              )}
            >
              Open
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </div>
        </li>
      ))}
    </ul>
  )
}
