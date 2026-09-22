import { Container } from '@/components/layout/site-shell'

const STEPS = [
  {
    n: '01',
    title: 'Search',
    body: 'Type a name. We check it across every extension we carry and show you what it costs to register — and what it costs to keep.',
  },
  {
    n: '02',
    title: 'Pay in naira',
    body: 'Card, bank transfer or USSD, through Flutterwave. No foreign-currency conversion on your statement, no declined international payment.',
  },
  {
    n: '03',
    title: 'Point it at your host',
    body: 'Pick your host from the list and we fill in the nameservers, or paste the two your host gave you. We confirm it worked.',
  },
] as const

export function HowItWorks() {
  return (
    <section id="how-it-works" aria-labelledby="how-it-works-heading" className="scroll-mt-8">
      <Container className="py-14 sm:py-20">
        <div className="max-w-2xl">
          <h2
            id="how-it-works-heading"
            className="text-2xl font-bold tracking-tight text-balance sm:text-3xl lg:text-4xl"
          >
            Three steps, no tutorial
          </h2>
          <p className="mt-4 text-pretty text-muted-foreground">
            Buying a domain should take a few minutes, not an afternoon of reading support articles.
          </p>
        </div>

        <ol className="mt-10 grid gap-8 md:grid-cols-3 lg:gap-12">
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
  )
}
