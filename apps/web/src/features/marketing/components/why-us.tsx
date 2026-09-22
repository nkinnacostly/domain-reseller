import { BellRing, Receipt, ShieldCheck, Wallet } from 'lucide-react'
import { Container } from '@/components/layout/site-shell'

/**
 * The four differentiators from the PRD's competitive analysis (§4.5).
 * Each one is a promise the product has to keep — do not add a fifth here
 * unless the product actually delivers it.
 */
const POINTS = [
  {
    icon: Receipt,
    title: 'The renewal price, upfront',
    body: 'Renewal shock is the single most common complaint about every registrar. We show what a domain renews at next to what it costs today — on the search results, in the cart, on the receipt.',
  },
  {
    icon: Wallet,
    title: 'Naira, and a published FX policy',
    body: 'We convert at a live market rate, cross-checked against two independent sources and published on our pricing page. Your price does not move while you are deciding, and we tell you exactly how we arrived at it.',
  },
  {
    icon: BellRing,
    title: 'Reminders that actually reach you',
    body: 'Email alone does not work here. Renewal reminders go out by WhatsApp and SMS too, starting a month before expiry, so a domain never lapses because a message went to spam.',
  },
  {
    icon: ShieldCheck,
    title: 'Your domain stays yours',
    body: 'Transfer lock on by default, two-factor authentication on your account, and an authorisation code released within five days whenever you ask — never held over a billing dispute.',
  },
] as const

export function WhyUs() {
  return (
    <section aria-labelledby="why-us-heading" className="bg-muted/40">
      <Container className="py-14 sm:py-20">
        <div className="max-w-2xl">
          <h2
            id="why-us-heading"
            className="text-2xl font-bold tracking-tight text-balance sm:text-3xl lg:text-4xl"
          >
            Built for how domains are actually bought in Nigeria
          </h2>
          <p className="mt-4 text-pretty text-muted-foreground">
            International registrars price in dollars and decline local cards. Local resellers bury
            the renewal price. We do neither.
          </p>
        </div>

        <ul className="mt-10 grid gap-x-10 gap-y-10 md:grid-cols-2">
          {POINTS.map((point) => (
            <li key={point.title} className="flex gap-4">
              <span className="grid size-11 shrink-0 place-items-center rounded-full bg-accent/10 text-accent">
                <point.icon className="size-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h3 className="font-semibold text-foreground">{point.title}</h3>
                <p className="mt-2 text-pretty text-sm/6 text-muted-foreground">{point.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  )
}
