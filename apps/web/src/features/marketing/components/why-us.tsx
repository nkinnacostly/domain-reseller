import { CurrencyNgn, LockKey, Receipt, ShieldCheck } from '@phosphor-icons/react/ssr'
import { BRAND_NAME } from '@/components/layout/brand'
import { Container } from '@/components/layout/site-shell'

/**
 * The differentiators from the PRD's competitive analysis (§4.5), each one a
 * promise the product keeps today. Do not add a card unless the product
 * actually delivers it (N9b) — renewal reminders by SMS and WhatsApp were
 * listed here before they existed, and are not built yet.
 */
export function WhyUs({ rate }: { rate: number | null }) {
  const points = [
    {
      icon: Receipt,
      title: 'The renewal price, upfront',
      body: 'What a domain renews at sits next to what it costs today — in search results, in your cart and at checkout. The second year is never a surprise.',
    },
    {
      icon: CurrencyNgn,
      title: 'Naira at a published rate',
      body:
        rate === null
          ? 'Registries bill in US dollars. We convert at one rate and publish it on our pricing page, rather than burying it in the total.'
          : `Registries bill in US dollars. We convert at one rate — ₦${rate.toLocaleString('en-NG')} to the dollar today — and publish it on our pricing page.`,
    },
    {
      icon: ShieldCheck,
      title: 'Contact privacy at no charge',
      body: 'Where the extension allows it, your name, address and phone number stay out of the public registration record, at no extra cost.',
    },
    {
      icon: LockKey,
      title: 'Your domain stays yours',
      body: 'Transfer lock on by default, two-factor authentication for sensitive changes, and your transfer code within five days of asking — never held over a bill.',
    },
  ] as const

  return (
    <section aria-labelledby="why-us-heading">
      <Container className="py-16 sm:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <h2
            id="why-us-heading"
            className="text-3xl font-bold tracking-tight text-balance sm:text-4xl lg:text-5xl"
          >
            Why choose {BRAND_NAME}?
          </h2>
          <p className="mt-4 text-pretty text-muted-foreground">
            International registrars price in dollars and decline local cards. Local resellers bury
            the renewal price. We do neither.
          </p>
        </div>

        <ul className="mt-12 grid gap-5 sm:mt-16 md:grid-cols-2 lg:gap-6">
          {points.map((point) => (
            <li
              key={point.title}
              className="rounded-[2rem] border border-brand-subtle-border bg-brand-subtle p-7 sm:p-9"
            >
              <span
                aria-hidden="true"
                className="grid size-[4.5rem] place-items-center rounded-2xl bg-brand-foreground shadow-[0_12px_24px_-14px_rgb(0_0_0/0.3)]"
              >
                <point.icon weight="duotone" className="size-10 text-brand" />
              </span>
              <h3 className="mt-6 text-xl font-semibold text-foreground">{point.title}</h3>
              <p className="mt-2 text-pretty text-sm/6 text-muted-foreground">{point.body}</p>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  )
}
