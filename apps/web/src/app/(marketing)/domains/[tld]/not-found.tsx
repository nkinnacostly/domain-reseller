import { ArrowUpRight } from 'lucide-react'
import Link from 'next/link'
import { PageHero } from '@/components/layout/page-hero'
import { SiteFooter } from '@/components/layout/site-footer'
import { SiteHeader } from '@/components/layout/site-header'
import { Container } from '@/components/layout/site-shell'
import { MissingExtensionTitle } from '@/features/extensions/components/missing-extension-title'
import { DomainSearch } from '@/features/search/components/domain-search'

/**
 * An extension we do not sell (FR-PUB1): unknown, paused like the .ng family
 * (tlds.is_paused), or no longer offered by the supplier. A real 404 — no
 * page for search engines to send buyers to where nothing can be bought — that
 * still says plainly what happened and offers what we do sell.
 */
export default function ExtensionNotFound() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <PageHero
          eyebrow="Domain extensions"
          title={<MissingExtensionTitle />}
          intro="It isn't one of the extensions we can register for you at the moment. Search for a name in one we do sell, or browse every extension and its price."
          icons={['🧭', '🔍', '🌍']}
        >
          <DomainSearch />
        </PageHero>
        <Container className="py-12 sm:py-16">
          <Link
            href="/pricing"
            className="inline-flex h-12 items-center gap-2 rounded-full border border-border bg-background px-6 text-sm font-medium text-foreground transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
          >
            See every extension we sell
            <ArrowUpRight className="size-4" aria-hidden="true" />
          </Link>
        </Container>
      </main>
      <SiteFooter />
    </>
  )
}
