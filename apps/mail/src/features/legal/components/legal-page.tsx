import type { Icon } from '@phosphor-icons/react'
import { LockKey, Scales, Scroll } from '@phosphor-icons/react/ssr'
import { Container } from '@/components/layout/container'
import { NavLink } from '@/components/layout/nav-link'
import { PageHero } from '@/features/marketing/components/page-hero'
import { PageJsonLd } from '@/features/seo/components/json-ld'
import type { JsonLdNode } from '@/features/seo/lib/structured-data'
import { BUSINESS, LEGAL_DRAFT_NOTICE } from '@/lib/business'
import { cn } from '@/lib/utils'
import { LEGAL_DOCUMENTS } from '../lib/documents'

/**
 * The frame every legal and support page shares, as the shop's: the heading
 * on the blue panel, a plain reading column, and — for legal documents — the
 * other documents beside it. Legal text is read slowly and quoted back, so
 * it gets full-contrast body text and generous spacing.
 */
const PROSE = cn(
  'text-pretty text-[0.95rem]/7 text-foreground',
  '[&_p]:mt-3 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5',
  '[&_ol]:mt-3 [&_ol]:list-decimal [&_ol]:space-y-1.5 [&_ol]:pl-5',
  '[&_a]:rounded-sm [&_a]:font-medium [&_a]:text-brand-ink [&_a]:underline [&_a]:underline-offset-4 [&_a:hover]:text-foreground [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2 [&_a:focus-visible]:outline-ring',
  '[&_strong]:font-semibold [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]',
)

/**
 * Marks a page as a draft the owner's lawyer has not reviewed (MAIL-SPEC
 * §14.5): visibly, and in an HTML comment for anyone reading the source.
 */
export function DraftMark() {
  return (
    <>
      <span
        hidden
        // biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed HTML comment, no input — React has no other way to write one.
        dangerouslySetInnerHTML={{ __html: `<!-- ${LEGAL_DRAFT_NOTICE} -->` }}
      />
      <span className="inline-flex items-center rounded-full bg-brand-foreground px-3 py-1 text-xs font-semibold text-brand">
        {LEGAL_DRAFT_NOTICE}
      </span>
    </>
  )
}

export function LegalPage({
  title,
  path,
  intro,
  children,
  kind = 'legal',
  icons = [Scroll, Scales, LockKey],
  structuredData = [],
}: {
  title: string
  /** The page's own address, for its breadcrumb trail in structured data. */
  path: string
  intro?: React.ReactNode
  children: React.ReactNode
  /**
   * `legal`: a draft document, with the others listed beside it. `index`:
   * the list of documents. `support`: contact and abuse — not legal text.
   */
  kind?: 'legal' | 'index' | 'support'
  icons?: readonly Icon[]
  structuredData?: (JsonLdNode | null)[]
}) {
  const isDocument = kind === 'legal'
  const trail =
    kind === 'support'
      ? [{ name: title, path }]
      : kind === 'index'
        ? [{ name: 'Legal', path: '/legal' }]
        : [
            { name: 'Legal', path: '/legal' },
            { name: title, path },
          ]

  return (
    <>
      <PageJsonLd trail={trail} extra={structuredData} />
      <PageHero
        eyebrow={
          kind === 'support' ? (
            'Support'
          ) : (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <DraftMark />
              <span>Last updated {BUSINESS.legalUpdated}</span>
            </span>
          )
        }
        title={title}
        intro={intro}
        icons={icons}
      />
      <Container className="py-12 sm:py-16">
        <div
          className={cn(
            'grid gap-12',
            isDocument && 'lg:grid-cols-[minmax(0,1fr)_17rem] lg:gap-16',
          )}
        >
          <article className={cn('max-w-3xl min-w-0 space-y-10', PROSE)}>
            {isDocument ? (
              <p className="mt-0! rounded-2xl bg-tone-warning p-4 text-sm/6 text-tone-warning-foreground">
                <strong>{LEGAL_DRAFT_NOTICE}.</strong> Our lawyer has not reviewed this document
                yet, and it may change before MyDomainsHub Mail opens. Questions:{' '}
                <a
                  href={`mailto:${BUSINESS.email}`}
                  className="text-tone-warning-foreground! hover:text-tone-warning-foreground!"
                >
                  {BUSINESS.email}
                </a>
                .
              </p>
            ) : null}
            {children}
          </article>

          {isDocument ? (
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
                      className="block min-h-11 py-2.5 data-[current=true]:font-semibold data-[current=true]:text-brand-ink"
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
    </>
  )
}

/** One section with an anchor, so a clause can be linked to. */
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

/** The contact address as a link people can copy or click. */
export function EmailLink() {
  return <a href={`mailto:${BUSINESS.email}`}>{BUSINESS.email}</a>
}
