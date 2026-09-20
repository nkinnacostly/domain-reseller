import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Your domains' }

/**
 * Portfolio — the authenticated landing page (PRD FR-P1).
 * Users land here, not on a marketing dashboard.
 */
export default function DomainsPage() {
  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Your domains</h1>
      {/* <DomainPortfolio /> — features/domains/components/domain-portfolio.tsx */}
    </section>
  )
}
