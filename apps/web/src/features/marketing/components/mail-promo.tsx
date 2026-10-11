import { CurrencyNgn, EnvelopeSimple, Plugs } from '@phosphor-icons/react/ssr'
import { ArrowRight } from 'lucide-react'
import { BRAND_NAME } from '@/components/layout/brand'
import { Container } from '@/components/layout/site-shell'
import { BUSINESS } from '@/lib/business'

/**
 * MyDomainsHub Mail, from the same operator: a way across for someone who
 * has just found their domain and will want to send from it. It states what
 * Mail does today (N9b) — transactional email, sent by API or SMTP, plans in
 * naira with a Free plan — and leaves numbers to Mail's own pages, where
 * they are read from its plan rows. It sends email; it is not a mailbox.
 */
const POINTS = [
  {
    icon: EnvelopeSimple,
    title: 'Receipts, sign-in links and alerts',
    body: 'Sent from your own domain, with its DKIM, SPF and DMARC records checked for you.',
  },
  {
    icon: Plugs,
    title: 'By API or SMTP',
    body: 'One HTTP call from your code, or the SMTP settings of the app you already have.',
  },
  {
    icon: CurrencyNgn,
    title: 'Priced in naira',
    body: 'Start on the Free plan, with no card needed; paid plans are billed in naira.',
  },
] as const

const PRIMARY =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-brand px-6 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]'
const SECONDARY =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-border bg-background px-6 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]'

export function MailPromo() {
  return (
    <section aria-labelledby="mail-promo-heading">
      <Container className="py-16 sm:py-24">
        <div className="grid gap-10 rounded-[2rem] border border-brand-subtle-border bg-brand-subtle p-7 sm:p-10 lg:grid-cols-[1fr_1.1fr] lg:items-center lg:gap-14 lg:p-14">
          <div>
            <p className="text-sm font-semibold text-brand-ink">Also from {BRAND_NAME}</p>
            <h2
              id="mail-promo-heading"
              className="mt-2 text-3xl font-bold tracking-tight text-balance sm:text-4xl"
            >
              Send email from your domain
            </h2>
            <p className="mt-4 max-w-lg text-pretty text-muted-foreground">
              {BRAND_NAME} Mail sends your app’s transactional email — receipts, sign-in links and
              alerts — from a domain you own, whether you registered it here or not.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a href={BUSINESS.mailSite} className={PRIMARY}>
                Visit {BRAND_NAME} Mail
                <ArrowRight aria-hidden="true" className="size-4" />
              </a>
              <a href={`${BUSINESS.mailSite}/pricing`} className={SECONDARY}>
                See Mail pricing
              </a>
            </div>
          </div>

          <ul className="grid gap-4">
            {POINTS.map((point) => (
              <li
                key={point.title}
                className="flex gap-4 rounded-3xl border border-brand-subtle-border bg-card p-5 sm:p-6"
              >
                <span
                  aria-hidden="true"
                  className="grid size-12 shrink-0 place-items-center rounded-2xl bg-brand-subtle"
                >
                  <point.icon weight="duotone" className="size-6 text-brand-ink" />
                </span>
                <div className="min-w-0">
                  <h3 className="font-semibold text-foreground">{point.title}</h3>
                  <p className="mt-1 text-pretty text-sm/6 text-muted-foreground">{point.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </Container>
    </section>
  )
}
