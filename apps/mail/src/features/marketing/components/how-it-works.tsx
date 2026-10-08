import { API_KEY_PREFIX, EMAIL_LIMITS, SMTP_SETTINGS } from '@dr/shared/mail'
import type { Icon } from '@phosphor-icons/react'
import { ChartLineUp, Key, PaperPlaneTilt, ShieldCheck } from '@phosphor-icons/react/ssr'
import { Container } from '@/components/layout/container'

type Step = { title: string; body: React.ReactNode; icon: Icon }

const CODE = 'rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground'

/**
 * Verify, key, send, watch (MAIL-SPEC §1, §5, §6). Each step says what the
 * product does, in the spec's terms and no further (N9b).
 */
export const STEPS: Step[] = [
  {
    title: 'Verify your domain',
    icon: ShieldCheck,
    body: (
      <>
        Add the domain you send from. We give you three DKIM records to publish, plus an MX and an
        SPF record for its bounce address, and check them in public DNS until the domain is
        verified.
      </>
    ),
  },
  {
    title: 'Create an API key',
    icon: Key,
    body: (
      <>
        Keys start with <code className={CODE}>{API_KEY_PREFIX}</code>. We show a key once and keep
        only a hash of it, so store it somewhere safe.
      </>
    ),
  },
  {
    title: 'Send',
    icon: PaperPlaneTilt,
    body: (
      <>
        Post each email to <code className={CODE}>/api/v1/emails</code> with a from, to, subject,
        and html or text — up to {EMAIL_LIMITS.maxRecipients} recipients. With an{' '}
        <code className={CODE}>Idempotency-Key</code>, a retry within 24 hours never sends it twice.
        Or send over SMTP through <code className={CODE}>{SMTP_SETTINGS.host}</code>, with the key
        as the password.
      </>
    ),
  },
  {
    title: 'Watch deliveries',
    icon: ChartLineUp,
    body: (
      <>
        Each email moves from queued to sent, then delivered — or bounced, complained or failed.
        Read its status in your dashboard, or from{' '}
        <code className={CODE}>GET /api/v1/emails/&#123;id&#125;</code>.
      </>
    ),
  },
]

export function HowItWorks() {
  return (
    <section id="how-it-works" aria-labelledby="how-it-works-heading" className="scroll-mt-8">
      <Container className="py-16 sm:py-24">
        <div className="max-w-2xl">
          <p className="text-sm font-semibold text-brand-ink">How it works</p>
          <h2
            id="how-it-works-heading"
            className="mt-2 text-3xl font-bold tracking-tight text-balance sm:text-4xl"
          >
            From your domain to the inbox in four steps
          </h2>
        </div>

        <ol className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, index) => (
            <li
              key={step.title}
              className="rounded-3xl border border-brand-subtle-border bg-card p-6 shadow-xs"
            >
              <span
                aria-hidden="true"
                className="grid size-12 place-items-center rounded-2xl bg-brand-subtle"
              >
                <step.icon weight="duotone" className="size-6 text-brand-ink" />
              </span>
              <p className="mt-5 text-sm font-semibold text-brand-ink">Step {index + 1}</p>
              <h3 className="mt-1 text-lg font-semibold tracking-tight">{step.title}</h3>
              <p className="mt-2 text-pretty text-sm/6 text-muted-foreground">{step.body}</p>
            </li>
          ))}
        </ol>
      </Container>
    </section>
  )
}
