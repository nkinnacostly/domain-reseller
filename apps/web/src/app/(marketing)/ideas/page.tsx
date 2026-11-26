import { Lightbulb, MagnifyingGlass, SealCheck } from '@phosphor-icons/react/ssr'
import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PageHero } from '@/components/layout/page-hero'
import { SiteFooter } from '@/components/layout/site-footer'
import { SiteHeader } from '@/components/layout/site-header'
import {
  NameFinderPanel,
  NameFinderPanelSkeleton,
} from '@/features/search/components/name-finder-panel'
import { PageJsonLd } from '@/features/seo/components/breadcrumb-json-ld'
import { pageMetadata } from '@/features/seo/lib/metadata'

export const metadata: Metadata = pageMetadata({
  title: 'Domain name ideas for your business',
  description:
    'Describe your business in a sentence and get domain names that are free to register, each with its first-year and renewal price.',
  path: '/ideas',
})

/**
 * The AI name finder (docs: "Making AI the core of MyDomainsHub", feature 1).
 * The page is static; ideas are asked for from the page with a POST, so no
 * description sits in an address and no crawler starts a lookup.
 */
export default function IdeasPage() {
  return (
    <>
      <SiteHeader />
      <PageJsonLd trail={[{ name: 'Domain name ideas', path: '/ideas' }]} />

      <main id="main">
        <PageHero
          title="Find a name for your business"
          intro="Describe what you do in a sentence. We suggest names — in English, Pidgin, Yoruba, Igbo or Hausa — check which are free, and show what each costs now and at renewal."
          icons={[Lightbulb, MagnifyingGlass, SealCheck]}
        >
          <Suspense fallback={<NameFinderPanelSkeleton />}>
            <NameFinderPanel />
          </Suspense>
        </PageHero>
      </main>

      <SiteFooter />
    </>
  )
}
