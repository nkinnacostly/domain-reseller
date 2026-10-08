import { EMAIL_LIMITS, SMTP_SETTINGS } from '@dr/shared/mail'
import { BracketsCurly, EnvelopeSimple } from '@phosphor-icons/react/ssr'
import { ArrowRight } from 'lucide-react'
import Link from 'next/link'
import { Container } from '@/components/layout/container'

const CARD = 'flex flex-col rounded-3xl border border-brand-subtle-border bg-card p-6 sm:p-8'
const ICON = 'grid size-12 shrink-0 place-items-center rounded-2xl bg-brand-subtle'
const MORE =
  'inline-flex min-h-11 w-fit items-center gap-2 rounded-full border border-border bg-background px-6 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]'
const LINK =
  'rounded-sm font-medium text-brand-ink underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/**
 * The API or SMTP (MAIL-SPEC §6): the same sending, two ways in. The SMTP
 * card's settings are the relay's own (`SMTP_SETTINGS`), and both cards say
 * only what each way does (N9b) — tags and scheduling are the API's alone.
 */
export function WaysToSend() {
  const [port] = SMTP_SETTINGS.ports
  return (
    <section aria-labelledby="ways-to-send-heading">
      <Container className="pb-16 sm:pb-24">
        <div className="max-w-2xl">
          <p className="text-sm font-semibold text-brand-ink">Two ways in</p>
          <h2
            id="ways-to-send-heading"
            className="mt-2 text-3xl font-bold tracking-tight text-balance sm:text-4xl"
          >
            Send with our API, or over SMTP
          </h2>
          <p className="mt-4 text-pretty text-muted-foreground">
            Both go through the same checks, caps and suppression list, and land in the same log.
          </p>
        </div>

        <div className="mt-12 grid gap-6 md:grid-cols-2">
          <div className={CARD}>
            <span aria-hidden="true" className={ICON}>
              <BracketsCurly weight="duotone" className="size-6 text-brand-ink" />
            </span>
            <h3 className="mt-5 text-lg font-semibold tracking-tight">The API</h3>
            <p className="mt-2 text-pretty text-sm/6 text-muted-foreground">
              One HTTP call an email, JSON in and out. Batches of up to {EMAIL_LIMITS.maxBatch},
              sending later, retries that never send twice, tags, and signed webhooks for every
              delivery, bounce and complaint.
            </p>
            {/* At the card's foot, so both buttons line up side by side. */}
            <div className="mt-auto pt-6">
              <Link href="/docs/quickstart" className={MORE}>
                Read the quickstart
                <ArrowRight aria-hidden="true" className="size-4" />
              </Link>
            </div>
          </div>

          <div className={CARD}>
            <span aria-hidden="true" className={ICON}>
              <EnvelopeSimple weight="duotone" className="size-6 text-brand-ink" />
            </span>
            <h3 className="mt-5 text-lg font-semibold tracking-tight">SMTP</h3>
            <p className="mt-2 text-pretty text-sm/6 text-muted-foreground">
              WordPress, Laravel, Django or PHPMailer already set up for email? Change its SMTP
              settings — no code to write.
            </p>
            <dl
              aria-label="SMTP settings"
              className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-1.5 rounded-2xl bg-brand-subtle px-5 py-4 text-sm text-brand-ink"
            >
              <dt>Host</dt>
              <dd className="break-all font-mono">{SMTP_SETTINGS.host}</dd>
              <dt>Port</dt>
              <dd className="font-mono">
                {port} <span className="font-sans">(SSL/TLS)</span>
              </dd>
              <dt>Password</dt>
              <dd>Your API key</dd>
            </dl>
            {/* At the card's foot, so both buttons line up side by side. */}
            <div className="mt-auto pt-6">
              <Link href="/docs/smtp" className={MORE}>
                See the SMTP settings
                <ArrowRight aria-hidden="true" className="size-4" />
              </Link>
            </div>
          </div>
        </div>

        <p className="mt-8 max-w-2xl text-pretty text-sm/6 text-muted-foreground">
          Moving from Resend? Keep its Node.js SDK: a new key and one base URL.{' '}
          <Link href="/docs/resend" className={LINK}>
            Switching from Resend
          </Link>
          . You can bring your old provider’s bounce and unsubscribe list too.
        </p>
      </Container>
    </section>
  )
}
