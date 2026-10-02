import { GlobeHemisphereEast, LinkSimple, TextAa } from '@phosphor-icons/react/ssr'
import type { Metadata } from 'next'
import Link from 'next/link'
import { PageHero } from '@/components/layout/page-hero'
import { SiteFooter } from '@/components/layout/site-footer'
import { SiteHeader } from '@/components/layout/site-header'
import { Container } from '@/components/layout/site-shell'
import { ExtensionDirectory } from '@/features/extensions/components/extension-directory'
import { buildDirectory } from '@/features/extensions/lib/directory'
import { listExtensionPages } from '@/features/extensions/queries/extension'
import { PageJsonLd } from '@/features/seo/components/breadcrumb-json-ld'
import { pageMetadata } from '@/features/seo/lib/metadata'

export const metadata: Metadata = pageMetadata({
  title: 'All domain extensions, A–Z',
  description:
    'Every domain extension you can register with us, from .com and .org to .africa and .io — each with its own page showing the first-year and renewal price in naira.',
  path: '/domains',
})

/**
 * The directory of extension pages (FR-PUB1): every one we sell, linked.
 * Built from the same cached catalogue read as the extension pages, so it
 * changes when the catalogue does.
 */
export default async function DomainsIndexPage() {
  const entries = await listExtensionPages()
  const directory = entries ? buildDirectory(entries) : null

  return (
    <>
      <PageJsonLd trail={[{ name: 'Domain extensions', path: '/domains' }]} />
      <SiteHeader />
      <main id="main">
        <PageHero
          eyebrow="Domain extensions"
          title="Every extension we sell"
          intro={
            <p>
              {directory ? `${directory.total.toLocaleString('en-NG')} extensions, each` : 'Each'}{' '}
              with its own page: the first-year and renewal price in naira, how long you can
              register it for, and who can. To compare prices side by side, see the{' '}
              <Link href="/pricing" className="font-medium underline underline-offset-4">
                pricing page
              </Link>
              .
            </p>
          }
          icons={[GlobeHemisphereEast, TextAa, LinkSimple]}
        />
        {directory ? (
          <ExtensionDirectory directory={directory} />
        ) : (
          <Container className="py-16">
            <div
              role="status"
              className="max-w-2xl rounded-2xl border border-border border-dashed p-8 sm:p-12"
            >
              <p className="font-semibold text-foreground">The list is briefly unavailable</p>
              <p className="mt-2 text-pretty text-sm/6 text-muted-foreground">
                Try again in a few minutes. The{' '}
                <Link href="/pricing" className="font-medium underline underline-offset-4">
                  pricing page
                </Link>{' '}
                lists every extension too.
              </p>
            </div>
          </Container>
        )}
      </main>
      <SiteFooter />
    </>
  )
}
