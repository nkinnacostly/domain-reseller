import { BookOpenText, Code, Terminal } from '@phosphor-icons/react/ssr'
import type { Metadata } from 'next'
import { DocsLanding } from '@/features/marketing/components/docs-landing'
import { PageHero } from '@/features/marketing/components/page-hero'
import { PageJsonLd } from '@/features/seo/components/json-ld'
import { pageMetadata } from '@/features/seo/lib/metadata'

export const metadata: Metadata = pageMetadata({
  title: 'Docs',
  description: 'Documentation for sending email with the MyDomainsHub Mail API.',
  path: '/docs',
})

/** The docs landing (MAIL-SPEC §6): a placeholder until the docs package writes the guides. */
export default function DocsPage() {
  return (
    <>
      <PageJsonLd trail={[{ name: 'Docs', path: '/docs' }]} />
      <PageHero
        eyebrow="Docs"
        title="Documentation"
        intro={<p>Where the guides to sending with the MyDomainsHub Mail API live.</p>}
        icons={[BookOpenText, Terminal, Code]}
      />
      <DocsLanding />
    </>
  )
}
