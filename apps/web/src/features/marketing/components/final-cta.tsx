import { Container } from '@/components/layout/site-shell'
import { DomainSearch } from '@/features/search/components/domain-search'

export function FinalCta() {
  return (
    <section aria-labelledby="final-cta-heading">
      <Container className="py-14 sm:py-20">
        <div className="mx-auto max-w-2xl text-center">
          <h2
            id="final-cta-heading"
            className="text-2xl font-bold tracking-tight text-balance sm:text-3xl lg:text-4xl"
          >
            Find the name before someone else does
          </h2>
          <p className="mt-4 text-pretty text-muted-foreground">
            Good domains go quickly. Check yours — it takes a few seconds and costs nothing to look.
          </p>
          <div className="mt-8 text-left">
            <DomainSearch formLabel="Domain search, end of page" />
          </div>
        </div>
      </Container>
    </section>
  )
}
