import { TRANSFER_LOCK_DAYS } from '@dr/shared'
import { MailCheck, ServerCog, UserRoundPen } from 'lucide-react'
import { Container } from '@/components/layout/site-shell'

/**
 * How a transfer works, and the three things that go wrong in practice.
 *
 * Every timing here is ICANN Transfer Policy: the auth code within five
 * calendar days of asking, default approval five days after the registry
 * notifies the losing registrar, and the waiting periods in TRANSFER_LOCK_DAYS.
 */
const STEPS = [
  {
    n: '01',
    title: 'Unlock it',
    body: 'At your current registrar, turn off the transfer lock. It may be called registrar lock or domain lock.',
  },
  {
    n: '02',
    title: 'Get the auth code',
    body: 'Ask your current registrar for it — also called the EPP or transfer code. They must give it to you within five days.',
  },
  {
    n: '03',
    title: 'Enter it and pay',
    body: 'Pay the transfer price in naira. Where the registry adds a year to your registration, that year is included.',
  },
  {
    n: '04',
    title: 'Approve, or just wait',
    body: 'Your current registrar may email you to confirm. If they have not answered within five days, the registry completes the move.',
  },
] as const

const CAUTIONS = [
  {
    icon: ServerCog,
    title: 'Is your DNS hosted at your registrar?',
    body: 'Copy your DNS records to your web host and point your nameservers there before you move. Some registrars delete the records when a domain leaves, and your website and email go with them.',
  },
  {
    icon: MailCheck,
    title: 'Can you read the email on the domain?',
    body: 'Your current registrar may send a confirmation to the owner email. If privacy protection forwards it, make sure the forwarding still reaches you.',
  },
  {
    icon: UserRoundPen,
    title: 'Changed the owner recently?',
    body: `Changing the registrant can lock a domain against transfers for ${TRANSFER_LOCK_DAYS} days, unless you opted out when you made the change. Our check cannot see this one.`,
  },
] as const

export function TransferGuide() {
  return (
    <>
      <section
        id="how-transfers-work"
        aria-labelledby="transfer-steps-heading"
        className="scroll-mt-8"
      >
        <Container className="py-14 sm:py-20">
          <div className="max-w-2xl">
            <h2
              id="transfer-steps-heading"
              className="text-2xl font-bold tracking-tight text-balance sm:text-3xl lg:text-4xl"
            >
              Four steps, most of them at your old registrar
            </h2>
            <p className="mt-4 text-pretty text-muted-foreground">
              A transfer changes who manages your registration. Done right, your website and email
              never notice, and the time you have already paid for comes with it.
            </p>
          </div>

          <ol className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4 lg:gap-10">
            {STEPS.map((step) => (
              <li key={step.n} className="border-border border-t pt-6">
                <span className="text-sm font-semibold text-accent tabular-nums">{step.n}</span>
                <h3 className="mt-3 text-lg font-semibold text-foreground">{step.title}</h3>
                <p className="mt-2 text-pretty text-sm/6 text-muted-foreground">{step.body}</p>
              </li>
            ))}
          </ol>
        </Container>
      </section>

      <section aria-labelledby="transfer-cautions-heading" className="bg-muted/40">
        <Container className="py-14 sm:py-20">
          <div className="max-w-2xl">
            <h2
              id="transfer-cautions-heading"
              className="text-2xl font-bold tracking-tight text-balance sm:text-3xl"
            >
              Before you start
            </h2>
            <p className="mt-4 text-pretty text-muted-foreground">
              The three things that turn a five-day transfer into a week of support tickets.
            </p>
          </div>

          <ul className="mt-10 grid gap-8 md:grid-cols-3 lg:gap-12">
            {CAUTIONS.map((item) => (
              <li key={item.title}>
                <span className="grid size-10 place-items-center rounded-full bg-background text-foreground ring-1 ring-border">
                  <item.icon className="size-4.5" aria-hidden="true" />
                </span>
                <h3 className="mt-4 font-semibold text-foreground">{item.title}</h3>
                <p className="mt-2 text-pretty text-sm/6 text-muted-foreground">{item.body}</p>
              </li>
            ))}
          </ul>
        </Container>
      </section>
    </>
  )
}
