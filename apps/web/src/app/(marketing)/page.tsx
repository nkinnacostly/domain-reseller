import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Find your domain name',
  description:
    'Search 800+ domain extensions. Naira pricing, renewal price shown upfront, no hidden fees.',
}

export default function HomePage() {
  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-16 sm:py-24">
      <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
        Find your domain name
      </h1>
      <p className="text-pretty text-muted-foreground sm:text-lg">
        Search 800+ extensions. We show the renewal price next to the first-year price, every time.
      </p>
      {/* <DomainSearch /> — features/search/components/domain-search.tsx */}
    </section>
  )
}
