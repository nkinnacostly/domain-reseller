import type { Icon } from '@phosphor-icons/react'
import { Fingerprint, Flask, PauseCircle, Prohibit } from '@phosphor-icons/react/ssr'
import { Container } from '@/components/layout/container'
import { formatCount } from '@/features/pricing/lib/plans'
import { SAFETY } from '../lib/site'

type Safeguard = { title: string; body: string; icon: Icon }

/**
 * What protects an account's deliverability, worded as MAIL-SPEC §4.1 and
 * §7 describe it — no stronger (N9b). Tenants isolate how reputation is
 * measured and acted on, not the sending addresses themselves, so the copy
 * says exactly that.
 */
export const SAFEGUARDS: Safeguard[] = [
  {
    title: 'Your reputation is measured on its own',
    icon: Fingerprint,
    body: 'Every account sends through its own Amazon SES tenant, so its bounces and complaints are tracked and acted on apart from other customers’, with its own suppression list.',
  },
  {
    title: 'Sandbox first, then a review',
    icon: Flask,
    body: `A new account can send only to its own team’s confirmed addresses, up to ${formatCount(SAFETY.sandboxDailyCap)} a day, until its domain is verified, its profile is complete and we have reviewed it.`,
  },
  {
    title: 'Bad addresses are suppressed',
    icon: Prohibit,
    body: 'A hard bounce or a complaint puts the address on your account’s suppression list at once. Later emails to it are recorded as suppressed, never sent, and do not count against your caps.',
  },
  {
    title: 'Sending pauses before damage spreads',
    icon: PauseCircle,
    body: `Over a rolling ${SAFETY.windowDays} days with at least ${formatCount(SAFETY.minSends)} sends, we warn an account at ${SAFETY.warnBounce} bounces or ${SAFETY.warnComplaint} complaints, and pause its sending at ${SAFETY.pauseBounce} or ${SAFETY.pauseComplaint}. A person, not code, decides when it resumes.`,
  },
]

export function Deliverability() {
  return (
    <section aria-labelledby="deliverability-heading" className="bg-brand-subtle">
      <Container className="py-16 sm:py-24">
        <div className="max-w-2xl">
          <p className="text-sm font-semibold text-brand-ink">Deliverability</p>
          <h2
            id="deliverability-heading"
            className="mt-2 text-3xl font-bold tracking-tight text-balance sm:text-4xl"
          >
            What protects your sending reputation
          </h2>
          <p className="mt-4 text-pretty text-muted-foreground">
            Inbox providers judge senders by their bounces and complaints. These rules keep each
            account’s record its own, and catch a bad list early.
          </p>
        </div>

        <ul className="mt-12 grid gap-6 md:grid-cols-2">
          {SAFEGUARDS.map((safeguard) => (
            <li
              key={safeguard.title}
              className="flex gap-5 rounded-3xl border border-brand-subtle-border bg-card p-6"
            >
              <span
                aria-hidden="true"
                className="grid size-12 shrink-0 place-items-center rounded-2xl bg-brand-subtle"
              >
                <safeguard.icon weight="duotone" className="size-6 text-brand-ink" />
              </span>
              <div className="min-w-0">
                <h3 className="text-lg font-semibold tracking-tight">{safeguard.title}</h3>
                <p className="mt-2 text-pretty text-sm/6 text-muted-foreground">{safeguard.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  )
}
