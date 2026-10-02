import type { Icon } from '@phosphor-icons/react'
import { LockKey, Scales, Scroll } from '@phosphor-icons/react/ssr'
import { JsonLd } from '@/components/common/json-ld'
import { NavLink } from '@/components/layout/nav-link'
import { PageHero } from '@/components/layout/page-hero'
import { SiteFooter } from '@/components/layout/site-footer'
import { SiteHeader } from '@/components/layout/site-header'
import { Container } from '@/components/layout/site-shell'
import { breadcrumbLd, graph, type JsonLdNode } from '@/features/seo/lib/structured-data'
import { BUSINESS } from '@/lib/business'
import { env } from '@/lib/env'
import { cn } from '@/lib/utils'
import { LEGAL_DOCUMENTS } from '../lib/documents'

/**
 * The frame every legal and help page shares: the heading on the blue hero, a
 * plain reading column, and the other documents beside it. Legal text is read
 * slowly and quoted back, so it gets full-contrast body text and generous
 * spacing.
 */

const PROSE = cn(
  'text-pretty text-[0.95rem]/7 text-foreground',
  '[&_p]:mt-3 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5',
  '[&_ol]:mt-3 [&_ol]:list-decimal [&_ol]:space-y-1.5 [&_ol]:pl-5',
  '[&_a]:font-medium [&_a]:text-brand-ink [&_a]:underline [&_a]:underline-offset-4 [&_a:hover]:text-foreground',
  '[&_strong]:font-semibold',
)

export function LegalPage({
  title,
  path,
  intro,
  children,
  nav = 'legal',
  icons = [Scroll, Scales, LockKey],
  structuredData = [],
}: {
  title: string
  /** The page's own address, for its breadcrumb trail in structured data. */
  path: string
  intro?: React.ReactNode
  children: React.ReactNode
  /** Legal documents list the others beside them; help pages do not. */
  nav?: 'legal' | 'none'
  /** Emoji floating beside the heading on wide screens. */
  icons?: Icon[]
  /** More structured data for this page (an FAQ, the organization). */
  structuredData?: (JsonLdNode | null)[]
}) {
  const site = env.NEXT_PUBLIC_APP_URL
  const underLegal = nav === 'legal' && path !== '/legal'
  const crumbs = [
    { name: 'Home', path: '/' },
    ...(underLegal ? [{ name: 'Legal', path: '/legal' }] : []),
    { name: title, path },
  ]
  return (
    <>
      <JsonLd data={graph(breadcrumbLd(site, crumbs), ...structuredData)} />
      <SiteHeader />
      <main id="main">
        <PageHero
          eyebrow={`Last updated ${BUSINESS.lastUpdated}`}
          title={title}
          intro={intro}
          icons={icons}
        />
        <Container className="py-12 sm:py-16">
          <div
            className={cn(
              'grid gap-12',
              nav === 'legal' && 'lg:grid-cols-[minmax(0,1fr)_17rem] lg:gap-16',
            )}
          >
            <article className={cn('max-w-3xl min-w-0 space-y-10', PROSE)}>{children}</article>

            {nav === 'legal' ? (
              <nav
                aria-label="Legal documents"
                className="h-fit rounded-[2rem] border border-brand-subtle-border bg-brand-subtle p-6 lg:sticky lg:top-8"
              >
                <h2 className="text-sm font-semibold text-foreground">Legal documents</h2>
                <ul className="mt-3 space-y-1 text-sm">
                  {LEGAL_DOCUMENTS.map((document) => (
                    <li key={document.href}>
                      <NavLink
                        href={document.href}
                        exact
                        className="block rounded-md py-2 text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                        activeClassName="font-semibold text-brand-ink underline"
                      >
                        {document.title}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </nav>
            ) : null}
          </div>
        </Container>
      </main>
      <SiteFooter />
    </>
  )
}

/** One numbered-free section with an anchor, so a clause can be linked to. */
export function LegalSection({
  id,
  title,
  children,
}: {
  id: string
  title: string
  children: React.ReactNode
}) {
  return (
    <section aria-labelledby={id} className="scroll-mt-24">
      <h2 id={id} className="text-xl font-semibold tracking-tight text-foreground">
        {title}
      </h2>
      {children}
    </section>
  )
}

/** A link out to an official text: opens in a new tab and says so. */
export function PolicyLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}

/** The contact address as a link people can copy or click. */
export function EmailLink() {
  return <a href={`mailto:${BUSINESS.email}`}>{BUSINESS.email}</a>
}
