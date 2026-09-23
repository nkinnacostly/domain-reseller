import Link from 'next/link'
import { PageHero } from '@/components/layout/page-hero'
import { SiteFooter } from '@/components/layout/site-footer'
import { SiteHeader } from '@/components/layout/site-header'
import { Container } from '@/components/layout/site-shell'
import { Button } from '@/components/ui/button'
import { DomainSearch } from '@/features/search/components/domain-search'

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <PageHero
          eyebrow="Error 404"
          title="Page not found"
          intro="That page doesn't exist or has moved. Search for a domain instead, or head back to the home page."
          icons={['🧭', '🔍', '🌍']}
        >
          <DomainSearch />
        </PageHero>
        <Container className="py-12 sm:py-16">
          <Button asChild size="lg" className="h-12 rounded-full px-6">
            <Link href="/">Back to the home page</Link>
          </Button>
        </Container>
      </main>
      <SiteFooter />
    </>
  )
}
