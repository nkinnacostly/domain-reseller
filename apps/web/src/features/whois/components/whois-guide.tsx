import { Container } from '@/components/layout/site-shell'
import { POLICY_LINKS } from '@/lib/business'

const SHOWN = [
  {
    emoji: '📌',
    title: 'Whether it is registered',
    body: 'And if it is not, a link to check it and register it.',
  },
  {
    emoji: '🏢',
    title: 'The registrar',
    body: 'The company the domain is registered through — the one to contact about it.',
  },
  {
    emoji: '📅',
    title: 'Key dates',
    body: 'When it was registered, when it expires, and when it last moved registrar.',
  },
  {
    emoji: '🔒',
    title: 'Status codes',
    body: 'Locks and pending changes, each explained in plain words.',
  },
  {
    emoji: '🧭',
    title: 'Nameservers',
    body: 'Where the domain points — usually the company hosting its website or email.',
  },
] as const

/**
 * What a lookup shows and where it comes from (PRD FR-PUB2, ADR-003). Every
 * sentence describes what the lookup does: RDAP via IANA's directory, a
 * 15-minute answer cache, and no owner details, ever.
 */
export function WhoisGuide() {
  return (
    <>
      <section aria-labelledby="whois-shows-heading">
        <Container className="py-16 sm:py-24">
          <div className="max-w-2xl">
            <h2
              id="whois-shows-heading"
              className="text-3xl font-bold tracking-tight text-balance sm:text-4xl"
            >
              What a lookup shows
            </h2>
            <p className="mt-4 text-pretty text-muted-foreground">
              The public part of a domain&apos;s registration record, as its registry publishes it.
            </p>
          </div>

          <ul className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-5">
            {SHOWN.map((item) => (
              <li key={item.title} className="rounded-3xl border border-border bg-card p-6">
                <span
                  aria-hidden="true"
                  className="grid size-12 place-items-center rounded-2xl bg-brand-subtle text-2xl"
                >
                  {item.emoji}
                </span>
                <h3 className="mt-4 font-semibold text-foreground">{item.title}</h3>
                <p className="mt-2 text-pretty text-sm/6 text-muted-foreground">{item.body}</p>
              </li>
            ))}
          </ul>
        </Container>
      </section>

      <section aria-labelledby="whois-source-heading">
        <Container className="pb-16 sm:pb-24">
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="rounded-[2rem] border border-brand-subtle-border bg-brand-subtle p-7 sm:p-10">
              <h2
                id="whois-source-heading"
                className="text-2xl font-bold tracking-tight text-balance sm:text-3xl"
              >
                Where the answer comes from
              </h2>
              <p className="mt-4 text-pretty text-sm/6 text-muted-foreground">
                Each lookup goes to the registry that runs the extension — Verisign for .com, for
                example — found through IANA&apos;s public directory, using RDAP, the service that
                has replaced WHOIS. Some country-code registries do not run it, and those we cannot
                look up. We keep an answer for up to 15 minutes, so a change made in the last few
                minutes may not show yet.
              </p>
            </div>

            <div className="rounded-[2rem] border border-border p-7 sm:p-10">
              <h2 className="text-2xl font-bold tracking-tight text-balance sm:text-3xl">
                Why owner details are hidden
              </h2>
              <p className="mt-4 text-pretty text-sm/6 text-muted-foreground">
                Data protection law, and ICANN&apos;s{' '}
                <a
                  href={POLICY_LINKS.registrationDataPolicy}
                  className="rounded-sm font-medium text-brand-ink underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  Registration Data Policy
                </a>
                , mean most registries no longer publish who owns a domain. We never show an
                owner&apos;s name or contact details, even when a registry does publish them. To
                reach an owner, contact the registrar named in the lookup.
              </p>
            </div>
          </div>
        </Container>
      </section>
    </>
  )
}
