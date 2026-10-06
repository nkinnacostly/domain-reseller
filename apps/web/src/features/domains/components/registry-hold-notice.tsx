import { TriangleAlert } from 'lucide-react'
import { domainLabel } from '@/components/common/domain-name'
import { BUSINESS } from '@/lib/business'

/**
 * Shown on a domain the registrar has put on hold (`isRegistryHold`). The
 * name does not resolve while it lasts, so the customer must not read
 * "Active" and wonder why their site is down. Says only what we know (N9b):
 * the hold, what it stops, that we are alerted (the reconcile's
 * `status_mismatch` drift is a critical ops alert), and who to ask. The
 * reason is the registrar's to give.
 */
export function RegistryHoldNotice({ domainName }: { domainName: string }) {
  return (
    <section
      aria-labelledby="registry-hold-heading"
      data-registry-hold
      className="rounded-2xl border border-destructive/40 bg-destructive/5 p-4 sm:p-5"
    >
      <h2
        id="registry-hold-heading"
        className="flex items-start gap-2.5 text-sm/6 font-semibold text-foreground"
      >
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
        This domain is on hold
      </h2>
      <p className="mt-1.5 text-pretty text-sm/6 text-muted-foreground">
        The registrar has put {domainLabel(domainName)} on hold, so it does not work on the internet
        right now: any website or email on it is offline. Changing its nameservers will not bring it
        back while the hold lasts. We are alerted automatically when this happens. Email{' '}
        <a
          href={`mailto:${BUSINESS.email}`}
          className="font-medium text-foreground underline underline-offset-4 hover:text-brand-ink focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {BUSINESS.email}
        </a>{' '}
        and we will find out why from the registrar and tell you.
      </p>
    </section>
  )
}
